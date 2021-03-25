# gp-v2-trading-bot

[![Node.js CI](https://github.com/gnosis/gp-v2-trading-bot/actions/workflows/CI.yml/badge.svg)](https://github.com/gnosis/gp-v2-trading-bot/actions/workflows/CI.yml)

*Script(s) to interact with gp-v2-contracts*

This repo can be used for educational purposes to bootstrap a programmatic integration or just serve as a playground to do random trades against the protocol.

## Usage

To install dependencies, run

```
yarn
```

To run the trade script, you need an account (in form of a mnemonic or private key) with some funds on you target network and potentially an Infura key (unless you are running on xDAI)

```
export PK=<private key with some funds>
export INFURA_KEY=<infura key> // Not needed on xDAI
```

You also need a [@uniswap/token-lists](https://github.com/Uniswap/token-lists) style token list from which a random trade will be determined (e.g. the [Uniswap default list](https://raw.githubusercontent.com/Uniswap/token-lists/master/test/schema/bigexample.tokenlist.json)).

```
yarn hardhat trade --token-list-url <token list> --network <network>
```

This command will fetch a random token pair for which your account has sell balance from the token list, give approval if necessary, and place a sell order on GPv2. It will then wait for the trade to happen and return successfully if this was the case. It will fail in case there was any error along the way.

## Contributing

Before submitting a PR make sure the changes comply with our linting rules.

```
yarn lint
```
