import "@nomiclabs/hardhat-ethers";
import dotenv from "dotenv";
import { task } from "hardhat/config";
import type { HttpNetworkUserConfig } from "hardhat/types";
import yargs from "yargs";

import { makeTrade } from "./src/make_trade";

const argv = yargs
  .option("network", {
    type: "string",
    default: "rinkeby",
  })
  .help(false)
  .version(false).argv;

// Load environment variables.
dotenv.config();
const { INFURA_KEY, MNEMONIC, PK } = process.env;

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

if (["rinkeby", "mainnet"].includes(argv.network) && INFURA_KEY === undefined) {
  throw new Error(
    `Could not find Infura key in env, unable to connect to network ${argv.network}`
  );
}

task("trade", "Makes a random trade on GPv2 given the users balances")
  .addParam("tokenListUrl", "The token-list to use to identify tradable tokens")
  .setAction(async ({ tokenListUrl }, hardhatRuntime) => {
    await makeTrade(tokenListUrl, hardhatRuntime);
  });

export default {
  solidity: "0.7.3",
  networks: {
    mainnet: {
      ...sharedNetworkConfig,
      url: `https://mainnet.infura.io/v3/${INFURA_KEY}`,
    },
    rinkeby: {
      ...sharedNetworkConfig,
      url: `https://rinkeby.infura.io/v3/${INFURA_KEY}`,
    },
    xdai: {
      ...sharedNetworkConfig,
      url: "https://xdai.poanetwork.dev",
    },
  },
};
