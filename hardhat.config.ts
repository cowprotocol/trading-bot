import "@nomiclabs/hardhat-ethers";
import dotenv from "dotenv";
import { task, types } from "hardhat/config";
import type { HttpNetworkUserConfig } from "hardhat/types";
import yargs from "yargs";

import { makeTrade } from "./src/make_trade";

const argv = yargs
  .option("network", {
    type: "string",
    default: "rinkeby",
  })
  .help(false)
  .version(false)
  .parseSync();

// Load environment variables.
dotenv.config();
const { INFURA_KEY, MNEMONIC, PK, NODE_URL } = process.env;

const DEFAULT_MNEMONIC =
  "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat";

const sharedNetworkConfig: HttpNetworkUserConfig = {};
if (PK) {
  sharedNetworkConfig.accounts = [PK];
} else {
  sharedNetworkConfig.accounts = {
    mnemonic: MNEMONIC || DEFAULT_MNEMONIC,
  };
}

if (
  ["rinkeby", "mainnet"].includes(argv.network) &&
  NODE_URL === undefined &&
  INFURA_KEY === undefined
) {
  throw new Error(
    `Could not find Infura key in env, unable to connect to network ${argv.network}`
  );
}

task("trade", "Makes a random trade on GPv2 given the users balances")
  .addOptionalParam(
    "tokenListUrl",
    "The token-list to use to identify tradable tokens"
  )
  .addOptionalParam(
    "maxSlippageBps",
    "The maximum slippage the trader is willing to take in bps",
    100,
    types.int
  )
  .setAction(async ({ tokenListUrl, maxSlippageBps }, hardhatRuntime) => {
    await makeTrade(tokenListUrl, maxSlippageBps, hardhatRuntime);
  });

export default {
  solidity: "0.7.3",
  networks: {
    mainnet: {
      ...sharedNetworkConfig,
      chainId: 1,
      url: NODE_URL || `https://mainnet.infura.io/v3/${INFURA_KEY}`,
    },
    rinkeby: {
      ...sharedNetworkConfig,
      chainId: 4,
      url: NODE_URL || `https://rinkeby.infura.io/v3/${INFURA_KEY}`,
    },
    xdai: {
      ...sharedNetworkConfig,
      // Fix a gas price so that hardhat doesn't try to use EIP1559 which isn't supported on xDAI (but exposed by recent OE nodes)
      gasPrice: 1e9,
      chainId: 100,
      url: NODE_URL || "https://xdai.poanetwork.dev",
    },
  },
};
