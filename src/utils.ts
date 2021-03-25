import { Contract } from "@ethersproject/contracts";
import GPv2SettlementArtefact from "@gnosis.pm/gp-v2-contracts/deployments/mainnet/GPv2Settlement.json";
import { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import ERC20 from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { Network } from "hardhat/types";

export class ChainUtils {
  static fromNetwork(network: Network): Chain {
    if (network.config.chainId === 1) {
      return Chain.MAINNET;
    } else if (network.config.chainId === 4) {
      return Chain.RINKEBY;
    } else if (network.config.chainId === 100) {
      return Chain.XDAI;
    } else {
      throw `Unsexpected network ${network.config.chainId}`;
    }
  }
}

export enum Chain {
  MAINNET = 1,
  RINKEBY = 4,
  XDAI = 100,
}

export function selectRandom<T>(list: T[]): T {
  const index = Math.floor(Math.random() * list.length);
  return list[index];
}

export async function toERC20(
  address: string,
  ethers: HardhatEthersHelpers
): Promise<Contract> {
  return new Contract(address, ERC20.abi, ethers.provider);
}

export async function toSettlementContract(
  address: string,
  ethers: HardhatEthersHelpers
): Promise<Contract> {
  return new Contract(address, GPv2SettlementArtefact.abi, ethers.provider);
}
