import { OrderKind, Order } from "@gnosis.pm/gp-v2-contracts";
import {
  GPv2Settlement,
  GPv2AllowanceManager,
} from "@gnosis.pm/gp-v2-contracts/networks.json";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import { TokenInfo, TokenList } from "@uniswap/token-lists";
import { BigNumber, ethers } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import fetch from "node-fetch";

import { Api } from "./api";
import {
  ChainUtils,
  selectRandom,
  Signature,
  toERC20,
  toSettlementContract,
} from "./utils";

const MAX_ALLOWANCE = ethers.constants.MaxUint256;
const TRADE_TIMEOUT_SECONDS = 300;

type Ethers = typeof ethers & HardhatEthersHelpers;

export async function makeTrade(
  tokenListUrl: string | undefined,
  maxSlippageBps: number,
  { ethers, network }: HardhatRuntimeEnvironment
): Promise<void> {
  const [trader] = await ethers.getSigners();
  const chain = ChainUtils.fromNetwork(network);
  const api = new Api(network.name);

  console.log(`Using account ${trader.address}`);

  const allTokens = await fetchTokenList(
    tokenListUrl || ChainUtils.defaultTokenList(chain),
    chain
  );
  const tokensWithBalance = await filterTradableTokens(
    allTokens,
    trader,
    maxSlippageBps,
    ethers,
    api
  );
  if (tokensWithBalance.length === 0) {
    throw new Error(
      "Account doesn't have sufficient balance in any of the provided tokens"
    );
  }

  const {
    token: sellToken,
    balance: sellBalance,
    potentialBuyTokens,
  } = selectRandom(tokensWithBalance);
  const buyToken = selectRandom(potentialBuyTokens);

  await giveAllowanceIfNecessary(
    sellToken,
    sellBalance,
    trader,
    GPv2AllowanceManager[chain].address,
    ethers
  );

  const fee = await api.getFee(
    sellToken.address,
    buyToken.address,
    sellBalance,
    OrderKind.SELL
  );

  // This should rarely happen as we only select buy tokens for which fee was sufficient
  // in the first place. Only if approval took a long time and gas prices increased significantly
  // this could be an issue.
  if (sellBalance.lte(fee)) {
    throw new Error("Account doesn't have enough balance to pay fee");
  }

  const sellAmountAfterFee = sellBalance.sub(fee);
  const buyAmount = await api.estimateTradeAmount(
    sellToken.address,
    buyToken.address,
    sellAmountAfterFee,
    OrderKind.SELL
  );

  console.log(
    `🤹 Selling ${sellAmountAfterFee.toString()} of ${
      sellToken.name
    } for ${buyAmount} of ${buyToken.name} with a ${fee.toString()} fee`
  );

  const order = createOrder(
    sellToken,
    buyToken,
    sellAmountAfterFee,
    buyAmount,
    fee
  );
  const signature = await Signature.fromOrder(order, chain, trader);
  console.log(`🔏 Signed with "${signature.signatureScheme}"`);

  const uid = await api.placeOrder(order, signature);
  console.log(`✅ Successfully placed order with uid: ${uid}`);

  console.log(
    `\n⏳ Waiting up to ${TRADE_TIMEOUT_SECONDS}s for trade event...`
  );
  const hasTraded = await waitForTrade(
    GPv2Settlement[chain].address,
    trader.address,
    uid,
    ethers,
    api
  );
  if (!hasTraded) {
    throw new Error(`Order ${uid} wasn't traded in within timeout`);
  }

  const erc20 = await toERC20(buyToken.address, ethers);
  const balance = await erc20.balanceOf(trader.address);
  console.log(
    `Trade was successful 🎉 ! New ${buyToken.name} balance: ${balance}`
  );
}

async function fetchTokenList(
  tokenListUrl: string,
  chainId: number
): Promise<TokenInfo[]> {
  const response = await fetch(tokenListUrl);
  const list: TokenList = await response.json();
  return list.tokens.filter((token) => token.chainId === chainId);
}

interface SellTokenCandidate {
  token: TokenInfo;
  balance: BigNumber;
  potentialBuyTokens: TokenInfo[];
}

async function filterTradableTokens(
  allTokens: TokenInfo[],
  trader: SignerWithAddress,
  maxSlippageBps: number,
  ethers: Ethers,
  api: Api
): Promise<SellTokenCandidate[]> {
  return (
    await Promise.all(
      allTokens.map(async (token) => {
        const erc20 = await toERC20(token.address, ethers);
        const balance: BigNumber = await erc20.balanceOf(trader.address);
        let potentialBuyTokens: TokenInfo[] = [];
        // Since fetching potential buy tokens is expensive, only do it for tokens that have balance
        if (!balance.isZero()) {
          potentialBuyTokens = await getPotentialBuyTokens(
            token,
            allTokens,
            balance,
            maxSlippageBps,
            api
          );
        }
        return {
          token,
          balance,
          potentialBuyTokens,
        };
      })
    )
  ).filter((sellTokenCandidate) => {
    return (
      !sellTokenCandidate.balance.isZero() &&
      sellTokenCandidate.potentialBuyTokens.length > 0
    );
  });
}

async function getPotentialBuyTokens(
  sellToken: TokenInfo,
  candidates: TokenInfo[],
  balance: BigNumber,
  maxSlippageBps: number,
  api: Api
): Promise<TokenInfo[]> {
  const potentialBuyTokens = [];
  for (const buyToken of candidates) {
    if (sellToken === buyToken) {
      continue;
    }
    try {
      // Check that a fee path exists to the candidate
      const fee = await api.getFee(
        sellToken.address,
        buyToken.address,
        balance,
        OrderKind.SELL
      );
      if (fee.gte(balance)) {
        // We won't have enough balance to pay the fee
        continue;
      }

      // Check that a trade path exists to the candidate
      const fullProceeds = await api.estimateTradeAmount(
        sellToken.address,
        buyToken.address,
        balance,
        OrderKind.SELL
      );

      // Check that the trade is not incurring to much slippage.
      // Until we have a spot price endpoint, we can only estimate the slippage by querying proceeds for a much smaller trade amount
      const fractionalAmount = balance.div(100);
      const fractionalProceeds = await api.estimateTradeAmount(
        sellToken.address,
        buyToken.address,
        fractionalAmount,
        OrderKind.SELL
      );

      // Measuring price in buyAmount/sellAmount (higher being better for the trader)
      // fractionalPrice := fractionalProceeds / fractionalAmount
      // fullPrice := fullProceeds / amount
      // too much slippage if (fractionalPrice / fullPrice > 1 + maxSlippageBps)
      if (
        fractionalProceeds
          .mul(balance)
          .mul(10000)
          .div(fractionalAmount.mul(fullProceeds))
          .gt(BigNumber.from(10000 + maxSlippageBps))
      ) {
        continue;
      }
      potentialBuyTokens.push(buyToken);
    } catch {
      // ignoring tokens for which no fee path exists
    }
  }
  return potentialBuyTokens;
}

const keccak = ethers.utils.id;
const APP_DATA = keccak("GPv2 Trading Bot");

function createOrder(
  sellToken: TokenInfo,
  buyToken: TokenInfo,
  sellAmountAfterFee: BigNumber,
  buyAmount: BigNumber,
  fee: BigNumber
): Order {
  // getTime returns milliseconds, we are looking for seconds
  const now = Math.floor(new Date().getTime() / 1000);
  return {
    sellToken: sellToken.address,
    buyToken: buyToken.address,
    sellAmount: sellAmountAfterFee,
    // add 0.5 % slippage
    buyAmount: buyAmount.mul(995).div(1000),
    // valid 15 minutes
    validTo: now + 900,
    appData: APP_DATA,
    feeAmount: fee,
    kind: OrderKind.SELL,
    partiallyFillable: false,
    receiver: ethers.constants.AddressZero,
  };
}

async function giveAllowanceIfNecessary(
  sellToken: TokenInfo,
  sellAmount: BigNumber,
  trader: SignerWithAddress,
  allowanceManager: string,
  ethers: Ethers
) {
  const erc20 = await toERC20(sellToken.address, ethers);
  const allowance = await erc20.allowance(trader.address, allowanceManager);
  if (allowance.lt(sellAmount)) {
    const tx = await erc20
      .connect(trader)
      .approve(allowanceManager, MAX_ALLOWANCE);
    await tx.wait();
    console.log(`✅ Successfully set allowance for ${sellToken.name}`);
  }
}

async function waitForTrade(
  contract: string,
  trader: string,
  uid: string,
  ethers: Ethers,
  api: Api
): Promise<boolean> {
  const settlement = await toSettlementContract(contract, ethers);
  const traded = new Promise((resolve: (value: boolean) => void) => {
    ethers.provider.on(settlement.filters.Trade(trader), (log) => {
      // Hacky way to verify that the UID is part of the event data
      if (log.data.includes(uid.substring(2))) {
        resolve(true);
      }
    });
  });
  const timeout = new Promise((resolve: (value: boolean) => void) => {
    setTimeout(resolve, TRADE_TIMEOUT_SECONDS * 1000, false);
  });
  // EVM events are not very reliable, so in case we didn't receive it we query the API
  // for the executed sell amount before concluding no trade happened.
  const sawTradeEvent = await Promise.race([traded, timeout]);
  if (!sawTradeEvent) {
    return !(await api.getExecutedSellAmount(uid)).isZero();
  } else {
    return true;
  }
}
