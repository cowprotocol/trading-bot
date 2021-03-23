import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import ERC20 from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { TokenInfo, TokenList } from "@uniswap/token-lists";
import { BigNumber, Contract } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import fetch from "node-fetch";

export async function makeTrade(
  tokenListUrl: string,
  { ethers, network }: HardhatRuntimeEnvironment
): Promise<void> {
  const [trader] = await ethers.getSigners();
  if (!network.config.chainId) {
    throw "Network doesn't expose a chainId";
  }

  const allTokens = await fetchTokenList(tokenListUrl, network.config.chainId);
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

  console.log(
    `Selling ${sellBalance.toString()} of ${sellToken.name} for ${
      buyToken.name
    }`
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

function selectRandom<T>(list: T[]): T {
  const index = Math.floor(Math.random() * list.length);
  return list[index];
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

async function toERC20(
  address: string,
  ethers: HardhatEthersHelpers
): Promise<Contract> {
  return new Contract(address, ERC20.abi, ethers.provider);
}
