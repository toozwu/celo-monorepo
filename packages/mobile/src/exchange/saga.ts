import { CeloTransactionObject } from '@celo/contractkit'
import { ExchangeWrapper } from '@celo/contractkit/lib/wrappers/Exchange'
import { GoldTokenWrapper } from '@celo/contractkit/lib/wrappers/GoldTokenWrapper'
import { ReserveWrapper } from '@celo/contractkit/lib/wrappers/Reserve'
import { StableTokenWrapper } from '@celo/contractkit/lib/wrappers/StableTokenWrapper'
import { CELO_AMOUNT_FOR_ESTIMATE, DOLLAR_AMOUNT_FOR_ESTIMATE } from '@celo/utils/src/celoHistory'
import BigNumber from 'bignumber.js'
import { all, call, put, select, spawn, takeEvery, takeLatest } from 'redux-saga/effects'
import { showError } from 'src/alert/actions'
import { CeloExchangeEvents, FeeEvents } from 'src/analytics/Events'
import ValoraAnalytics from 'src/analytics/ValoraAnalytics'
import { TokenTransactionType } from 'src/apollo/types'
import { ErrorMessages } from 'src/app/ErrorMessages'
import {
  Actions,
  ExchangeTokensAction,
  FetchExchangeRateAction,
  FetchTobinTaxAction,
  setExchangeRate,
  setTobinTax,
} from 'src/exchange/actions'
import { ExchangeRatePair, exchangeRatePairSelector } from 'src/exchange/reducer'
import { CURRENCY_ENUM } from 'src/geth/consts'
import { navigate } from 'src/navigator/NavigationService'
import { Screens } from 'src/navigator/Screens'
import { convertToContractDecimals } from 'src/tokens/saga'
import {
  addStandbyTransaction,
  generateStandbyTransactionId,
  removeStandbyTransaction,
} from 'src/transactions/actions'
import { sendAndMonitorTransaction } from 'src/transactions/saga'
import { sendTransaction } from 'src/transactions/send'
import { TransactionStatus } from 'src/transactions/types'
import { getRateForMakerToken, getTakerAmount } from 'src/utils/currencyExchange'
import { roundDown } from 'src/utils/formatting'
import Logger from 'src/utils/Logger'
import { getContractKit } from 'src/web3/contracts'
import { getConnectedAccount, getConnectedUnlockedAccount } from 'src/web3/saga'
import * as util from 'util'

const TAG = 'exchange/saga'

const EXCHANGE_DIFFERENCE_TOLERATED = 0.01 // Maximum difference between actual and displayed takerAmount

export function* doFetchTobinTax({ makerAmount, makerToken }: FetchTobinTaxAction) {
  try {
    let tobinTax
    if (makerToken === CURRENCY_ENUM.GOLD) {
      yield call(getConnectedAccount)

      const contractKit = yield call(getContractKit)
      const reserve: ReserveWrapper = yield call([
        contractKit.contracts,
        contractKit.contracts.getReserve,
      ])

      const tobinTaxFraction = yield call(reserve.getOrComputeTobinTax().txo.call)

      if (!tobinTaxFraction) {
        Logger.error(TAG, 'Unable to fetch tobin tax')
        throw new Error('Unable to fetch tobin tax')
      }

      // Tobin tax represents % tax on gold transfer, stored as fraction tuple
      tobinTax = tobinTaxFraction['0'] / tobinTaxFraction['1']
      if (tobinTax > 0) {
        tobinTax = makerAmount.times(tobinTax).toString()
      }
    } else {
      // Tobin tax only charged for gold transfers
      tobinTax = 0
    }

    Logger.debug(TAG, `Retrieved Tobin tax rate: ${tobinTax}`)
    yield put(setTobinTax(tobinTax.toString()))
  } catch (error) {
    ValoraAnalytics.track(FeeEvents.fetch_tobin_tax_failed, { error: error.message })
    Logger.error(TAG, 'Error fetching Tobin tax', error)
    yield put(showError(ErrorMessages.CALCULATE_FEE_FAILED))
  }
}

export function* doFetchExchangeRate(action: FetchExchangeRateAction) {
  Logger.debug(TAG, 'Calling @doFetchExchangeRate')

  const { makerToken, makerAmount } = action
  try {
    ValoraAnalytics.track(CeloExchangeEvents.celo_fetch_exchange_rate_start)
    yield call(getConnectedAccount)

    let makerAmountInWei
    if (makerAmount && makerToken) {
      makerAmountInWei = (yield call(
        convertToContractDecimals,
        makerAmount,
        makerToken
      )).integerValue()
    }

    // If makerAmount and makerToken are given, use them to estimate the exchange rate,
    // as exchange rate depends on amount sold. Else default to preset large sell amount.
    const goldMakerAmount =
      makerAmountInWei && !makerAmountInWei.isZero() && makerToken === CURRENCY_ENUM.GOLD
        ? makerAmountInWei
        : CELO_AMOUNT_FOR_ESTIMATE
    const dollarMakerAmount =
      makerAmountInWei && !makerAmountInWei.isZero() && makerToken === CURRENCY_ENUM.DOLLAR
        ? makerAmountInWei
        : DOLLAR_AMOUNT_FOR_ESTIMATE

    const contractKit = yield call(getContractKit)

    const exchange: ExchangeWrapper = yield call([
      contractKit.contracts,
      contractKit.contracts.getExchange,
    ])

    const [dollarMakerExchangeRate, goldMakerExchangeRate]: [BigNumber, BigNumber] = yield all([
      call([exchange, exchange.getUsdExchangeRate], dollarMakerAmount),
      call([exchange, exchange.getGoldExchangeRate], goldMakerAmount),
    ])

    if (!dollarMakerExchangeRate || !goldMakerExchangeRate) {
      Logger.error(TAG, 'Invalid exchange rate')
      throw new Error('Invalid exchange rate')
    }

    Logger.debug(
      TAG,
      `Retrieved exchange rate:
      ${dollarMakerExchangeRate.toString()} gold per dollar, estimated at ${dollarMakerAmount}
      ${goldMakerExchangeRate.toString()} dollar per gold, estimated at ${goldMakerAmount}`
    )

    yield put(
      setExchangeRate({
        goldMaker: goldMakerExchangeRate.toString(),
        dollarMaker: dollarMakerExchangeRate.toString(),
      })
    )
    // Always tracking in dollars for consistancy
    ValoraAnalytics.track(CeloExchangeEvents.celo_fetch_exchange_rate_complete, {
      makerAmount: dollarMakerAmount,
      exchangeRate: dollarMakerExchangeRate.toNumber(),
    })
  } catch (error) {
    ValoraAnalytics.track(CeloExchangeEvents.celo_fetch_exchange_rate_error, {
      error: error.message,
    })
    Logger.error(TAG, 'Error fetching exchange rate', error)
    yield put(showError(ErrorMessages.EXCHANGE_RATE_FAILED))
  }
}

export function* exchangeGoldAndStableTokens(action: ExchangeTokensAction) {
  Logger.debug(`${TAG}@exchangeGoldAndStableTokens`, 'Exchanging gold and stable token')
  const { makerToken, makerAmount } = action
  Logger.debug(TAG, `Exchanging ${makerAmount.toString()} of token ${makerToken}`)
  let txId: string | null = null
  try {
    navigate(Screens.ExchangeHomeScreen) // Must navigate to final screen before getting unlocked account which prompts pin
    ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_start)
    const account: string = yield call(getConnectedUnlockedAccount)
    const exchangeRatePair: ExchangeRatePair = yield select(exchangeRatePairSelector)
    const exchangeRate = getRateForMakerToken(exchangeRatePair, makerToken)
    if (!exchangeRate) {
      ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_error, {
        error: 'Invalid exchange rate from exchange contract',
      })
      Logger.error(TAG, 'Invalid exchange rate from exchange contract')
      return
    }
    if (exchangeRate.isZero()) {
      ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_error, {
        error: 'Cannot do exchange with rate of 0',
      })
      Logger.error(TAG, 'Cannot do exchange with rate of 0. Stopping.')
      throw new Error('Invalid exchange rate')
    }

    txId = yield createStandbyTx(makerToken, makerAmount, exchangeRate, account)

    const contractKit = yield call(getContractKit)

    const goldTokenContract: GoldTokenWrapper = yield call([
      contractKit.contracts,
      contractKit.contracts.getGoldToken,
    ])
    const stableTokenContract: StableTokenWrapper = yield call([
      contractKit.contracts,
      contractKit.contracts.getStableToken,
    ])
    const exchangeContract: ExchangeWrapper = yield call([
      contractKit.contracts,
      contractKit.contracts.getExchange,
    ])

    const convertedMakerAmount: BigNumber = roundDown(
      yield call(convertToContractDecimals, makerAmount, makerToken),
      0
    ) // Nearest integer in wei
    const sellGold = makerToken === CURRENCY_ENUM.GOLD

    const updatedExchangeRate: BigNumber = yield call(
      // Updating with actual makerAmount, rather than conservative estimate displayed
      [exchangeContract, exchangeContract.getExchangeRate],
      convertedMakerAmount,
      sellGold
    )

    const exceedsExpectedSize =
      makerToken === CURRENCY_ENUM.GOLD
        ? convertedMakerAmount.isGreaterThan(CELO_AMOUNT_FOR_ESTIMATE)
        : convertedMakerAmount.isGreaterThan(DOLLAR_AMOUNT_FOR_ESTIMATE)

    if (exceedsExpectedSize) {
      Logger.error(
        TAG,
        `Displayed exchange rate was estimated with a smaller makerAmount than actual ${convertedMakerAmount}`
      )
      // Note that exchange will still go through if makerAmount difference is within EXCHANGE_DIFFERENCE_TOLERATED
    }

    // Ensure the user gets makerAmount at least as good as displayed (rounded to EXCHANGE_DIFFERENCE_TOLERATED)
    const minimumTakerAmount = BigNumber.maximum(
      getTakerAmount(makerAmount, exchangeRate).minus(EXCHANGE_DIFFERENCE_TOLERATED),
      0
    )
    const updatedTakerAmount = getTakerAmount(makerAmount, updatedExchangeRate)
    if (minimumTakerAmount.isGreaterThan(updatedTakerAmount)) {
      ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_error, {
        error: `Not receiving enough ${makerToken}. Expected ${minimumTakerAmount} but received ${updatedTakerAmount.toString()}`,
      })
      Logger.error(
        TAG,
        `Not receiving enough ${makerToken} due to change in exchange rate. Exchange failed.`
      )
      yield put(showError(ErrorMessages.EXCHANGE_RATE_CHANGE))
      return
    }

    const takerToken =
      makerToken === CURRENCY_ENUM.DOLLAR ? CURRENCY_ENUM.GOLD : CURRENCY_ENUM.DOLLAR
    const convertedTakerAmount: BigNumber = roundDown(
      yield call(convertToContractDecimals, minimumTakerAmount, takerToken),
      0
    )
    Logger.debug(
      TAG,
      `Will receive at least ${convertedTakerAmount}
      wei for ${convertedMakerAmount} wei of ${makerToken}`
    )

    let approveTx
    if (makerToken === CURRENCY_ENUM.GOLD) {
      approveTx = goldTokenContract.approve(
        exchangeContract.address,
        convertedMakerAmount.toString()
      )
    } else if (makerToken === CURRENCY_ENUM.DOLLAR) {
      approveTx = stableTokenContract.approve(
        exchangeContract.address,
        convertedMakerAmount.toString()
      )
    } else {
      ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_error, {
        error: `Unexpected maker token: ${makerToken}`,
      })
      Logger.error(TAG, `Unexpected maker token ${makerToken}`)
      return
    }
    yield call(sendTransaction, approveTx.txo, account, TAG, 'approval')
    Logger.debug(TAG, `Transaction approved: ${util.inspect(approveTx.txo.arguments)}`)

    contractKit.defaultAccount = account

    const tx: CeloTransactionObject<string> = yield exchangeContract.exchange(
      convertedMakerAmount.toString(),
      convertedTakerAmount.toString(),
      sellGold
    )

    if (!txId) {
      ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_error, { error: 'Missing tx id ' })
      Logger.error(TAG, 'No txId. Did not exchange.')
      return
    }
    yield call(sendAndMonitorTransaction, txId, tx, account)
    ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_complete)
  } catch (error) {
    ValoraAnalytics.track(CeloExchangeEvents.celo_exchange_error, { error: error.message })
    Logger.error(TAG, 'Error doing exchange', error)
    const isDollarToGold = makerToken === CURRENCY_ENUM.DOLLAR

    ValoraAnalytics.track(
      isDollarToGold ? CeloExchangeEvents.celo_buy_error : CeloExchangeEvents.celo_sell_error,
      {
        error,
      }
    )
    if (txId) {
      yield put(removeStandbyTransaction(txId))
    }

    if (error.message === ErrorMessages.INCORRECT_PIN) {
      yield put(showError(ErrorMessages.INCORRECT_PIN))
    } else {
      yield put(showError(ErrorMessages.EXCHANGE_FAILED))
    }
  }
}

function* createStandbyTx(
  makerToken: CURRENCY_ENUM,
  makerAmount: BigNumber,
  exchangeRate: BigNumber,
  account: string
) {
  const takerAmount = getTakerAmount(makerAmount, exchangeRate)
  const txId = generateStandbyTransactionId(account)
  yield put(
    addStandbyTransaction({
      id: txId,
      type: TokenTransactionType.Exchange,
      status: TransactionStatus.Pending,
      inSymbol: makerToken,
      inValue: makerAmount.toString(),
      outSymbol: makerToken === CURRENCY_ENUM.DOLLAR ? CURRENCY_ENUM.GOLD : CURRENCY_ENUM.DOLLAR,
      outValue: takerAmount.toString(),
      timestamp: Math.floor(Date.now() / 1000),
    })
  )
  return txId
}

export function* watchFetchTobinTax() {
  yield takeLatest(Actions.FETCH_TOBIN_TAX, doFetchTobinTax)
}

export function* watchFetchExchangeRate() {
  yield takeLatest(Actions.FETCH_EXCHANGE_RATE, doFetchExchangeRate)
}

export function* watchExchangeTokens() {
  yield takeEvery(Actions.EXCHANGE_TOKENS, exchangeGoldAndStableTokens)
}

export function* exchangeSaga() {
  yield spawn(watchFetchExchangeRate)
  yield spawn(watchFetchTobinTax)
  yield spawn(watchExchangeTokens)
}
