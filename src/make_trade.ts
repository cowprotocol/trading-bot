import {
  OrderKind,
  Order,
  signOrder as signOrderGP,
  SigningScheme,
  domain,
} from "@gnosis.pm/gp-v2-contracts";
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
  Chain,
  ChainUtils,
  selectRandom,
  toERC20,
  toSettlementContract,
} from "./utils";

const MAX_ALLOWANCE = ethers.constants.MaxUint256;
const TRADE_TIMEOUT_SECONDS = 300;

const { concat, hexlify, hexValue } = ethers.utils;

export async function makeTrade(
  tokenListUrl: string | undefined,
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
    ethers,
    api
  );
  if (tokensWithBalance.length === 0) {
    throw new Error(
      "Account doesn't have any balance in any of the provided token"
    );
  }

  const {
    token: sellToken,
    balance: sellBalance,
    potentialBuyTokens,
  } = selectRandom(tokensWithBalance);
  const buyToken = selectRandom(potentialBuyTokens);

  const fee = await api.getFee(
    sellToken.address,
    buyToken.address,
    sellBalance,
    OrderKind.SELL
  );

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

  await giveAllowanceIfNecessary(
    sellToken,
    sellBalance,
    trader,
    GPv2AllowanceManager[chain].address,
    ethers
  );

  const order = createOrder(
    sellToken,
    buyToken,
    sellAmountAfterFee,
    buyAmount,
    fee
  );
  const signature = await signOrder(order, chain, trader);
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
  ethers: HardhatEthersHelpers,
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
  amount: BigNumber,
  api: Api
): Promise<TokenInfo[]> {
  const potentialBuyTokens = [];
  for (const buyToken of candidates) {
    if (sellToken === buyToken) {
      continue;
    }
    try {
      await api.estimateTradeAmount(
        sellToken.address,
        buyToken.address,
        amount,
        OrderKind.SELL
      );
      await api.getFee(
        sellToken.address,
        buyToken.address,
        amount,
        OrderKind.SELL
      );
      potentialBuyTokens.push(buyToken);
    } catch {
      // ignoring tokens for which no fee path exists
    }
  }
  return potentialBuyTokens;
}

const keccak = ethers.utils.id;
// Using the most significant 4 bytes of a unique phrase's hash. TODO: use full hash after SC upgrade.
const APP_DATA = parseInt(
  ethers.utils.hexDataSlice(keccak("GPv2 Trading Bot"), 0, 4)
);

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
  };
}

async function signOrder(
  order: Order,
  chain: Chain,
  signer: SignerWithAddress
): Promise<string> {
  const signature = await signOrderGP(
    domain(chain, GPv2Settlement[chain].address),
    order,
    signer,
    SigningScheme.MESSAGE
  );

  // signOrderGP doesn't encode the signing scheme (MESSAGE requires MSB to be 1)
  // We therefore encode it manually.
  // TODO: no longer necessary as soon as we upgrade the SmartContracts
  const parts = ethers.utils.splitSignature(signature);
  parts.v = parts.v | 0x80;
  return hexlify(concat([parts.r, parts.s, hexValue(parts.v)]));
}

async function giveAllowanceIfNecessary(
  sellToken: TokenInfo,
  sellAmount: BigNumber,
  trader: SignerWithAddress,
  allowanceManager: string,
  ethers: HardhatEthersHelpers
) {
  const erc20 = await toERC20(sellToken.address, ethers);
  const allowance = await erc20.allowance(trader.address, allowanceManager);
  if (allowance.lt(sellAmount)) {
    await erc20.connect(trader).approve(allowanceManager, MAX_ALLOWANCE);
    console.log(`✅ Successfully set allowance for ${sellToken.name}`);
  }
}

async function waitForTrade(
  contract: string,
  trader: string,
  uid: string,
  ethers: HardhatEthersHelpers,
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
