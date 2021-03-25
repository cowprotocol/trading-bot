import { concat, hexlify, hexValue } from "@ethersproject/bytes";
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
import { Chain, ChainUtils, selectRandom, toERC20 } from "./utils";

const MAX_ALLOWANCE = ethers.constants.MaxUint256;

export async function makeTrade(
  tokenListUrl: string,
  { ethers, network }: HardhatRuntimeEnvironment
): Promise<void> {
  const [trader] = await ethers.getSigners();
  const chain = ChainUtils.fromNetwork(network);

  const allTokens = await fetchTokenList(tokenListUrl, chain);
  const tokensWithBalance = await filterTokensWithBalance(
    allTokens,
    trader,
    ethers
  );
  if (tokensWithBalance.length === 0) {
    throw "Account doesn't have any balance in any of the provided token";
  }

  const { token: sellToken, balance: sellBalance } = selectRandom(
    tokensWithBalance
  );
  const buyToken = selectRandom(
    allTokens.filter((token) => sellToken !== token)
  );

  const api = new Api(network.name);
  const fee = await api.getFee(
    sellToken.address,
    buyToken.address,
    sellBalance,
    OrderKind.SELL
  );

  if (sellBalance.lte(fee)) {
    throw "Account doesn't have enough balance to pay fee";
  }

  const sellAmountAfterFee = sellBalance.sub(fee);
  const buyAmount = await api.estimateTradeAmount(
    sellToken.address,
    buyToken.address,
    sellAmountAfterFee,
    OrderKind.SELL
  );

  console.log(
    `Selling ${sellAmountAfterFee.toString()} of ${
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
  console.log(`Successfully placed order with uid: ${uid}`);
}

async function fetchTokenList(
  tokenListUrl: string,
  chainId: number
): Promise<TokenInfo[]> {
  const response = await fetch(tokenListUrl);
  const list: TokenList = await response.json();
  return list.tokens.filter((token) => token.chainId === chainId);
}

interface TokenAndBalance {
  token: TokenInfo;
  balance: BigNumber;
}

async function filterTokensWithBalance(
  allTokens: TokenInfo[],
  trader: SignerWithAddress,
  ethers: HardhatEthersHelpers
): Promise<TokenAndBalance[]> {
  return (
    await Promise.all(
      allTokens.map(async (token) => {
        const erc20 = await toERC20(token.address, ethers);
        const balance: BigNumber = await erc20.balanceOf(trader.address);
        return {
          token,
          balance,
        };
      })
    )
  ).filter((tokenAndBalance) => {
    return !tokenAndBalance.balance.isZero();
  });
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
    console.log(`Successfully set allowance for ${sellToken.name}`);
  }
}
