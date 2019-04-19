'use strict'

import axios from "axios"
import * as util from "util"
import * as math from "mathjs"
import * as promptly from "promptly"

import {ArgumentParser} from "argparse"

import * as wallet from "./wallet"
import * as keystore from "./keystore"

const ENDPOINT_VOTE = "/oracle/denoms/%s/votes"
const ENDPOINT_ACCOUNT = "/auth/accounts/%s"
const ENDPOINT_BROADCAST = "/txs"

const defaultKeyName = "voter"

function registCommands(parser: ArgumentParser) {
  var subparsers = parser.addSubparsers({
    title:'commands',
    dest: "subparser_name",
    description:"Aavailable commands"
  });
  
  // Voting command
  var vote_command = subparsers.addParser('vote', {
    addHelp: true,
    description: "Get price data from sources, vote for all denoms in data"
  })
  
  vote_command.addArgument([ '-l', '--lcd'],
  {
    action: 'store',
    help: 'lcd address',
    required: true
  })
  
  vote_command.addArgument([ '-c', '--chain-id'],
  {
    action: 'store',
    help: 'chain ID',
    dest: 'chainID',
    required: true
  })
  
  vote_command.addArgument([ '-s', '--source'],
  {
    action: 'append',
    help: 'Append price data source(It can handle multiple sources)',
    required: true
  })
  
  vote_command.addArgument([ '-p', '--password'],
  {
    action: 'store',
    help: 'voter password'
  })
  
  // Updating Key command
  subparsers.addParser('setkey', {addHelp: true})
}

async function updateKey() {
  const password = promptly.password('Enter a passphrase to encrypt your key to disk:')
  const confirm = promptly.password('Repeat the passphrase:')
  const seeds = promptly.prompt('> Enter your bip39 mnemonic\n')

  if ( password.length < 8 ) {
    console.error("ERROR: password must be at least 8 characters")
    return
  }
  
  if ( password !== confirm ){
    console.error("ERROR: passphrases don't matchPassword confirm failed")
    return
  }
  
  if ( seeds.trim().split(" ").length !== 24 ) {
    console.error("Error: Mnemonic is not valid.")
    return
  }
  
  keystore.importKey(defaultKeyName, password, seeds)
  console.log("saved!")
}

async function getPrice(sources: any) {
  if ( !(sources instanceof Array) ) {
    sources = [sources]
  }
  
  var total = {}
  var res = await axios.all(sources.map(source => axios.get(source)))
  res.forEach(result => {
    try {
      if ( result['status'] == 200 ) {
        const prices = result['data']['prices'];
        prices.forEach(price => {
          if ( total[price.currency] != undefined ) {
            total[price.currency].push(price.price);
          } else {
            total[price.currency] = [price.price]
          }
        })
      }
    } catch(e) {
      console.error(e);
    }
  });
  
  Object.keys(total).forEach((key) => {
    total[key] = math.median(total[key]);
  });
  
  return total;
}

async function updateAndVoting(args: any, voter: any) {
  const {source, lcd: lcdAddress, chainID} = args;
  const prices = await getPrice(source)
  
  var res = await axios.get(util.format(lcdAddress + ENDPOINT_ACCOUNT, voter.terraAddress))
  const account = res.data.value
  
  for ( var currency in prices ) {
    try {
      await votePrice(lcdAddress, currency, prices[currency].toString(), voter, account, chainID)
      account.sequence = (parseInt(account.sequence)+1).toString();
    } catch(e) {
      console.error(e.response.data)
    }
  }
}

async function votePrice(lcdAddress: string, currency: string, price: string, voter: any, account: any, chainID: string) {
  
  const args = {
    base_req: {
      from: voter.terraAddress,
      memo: "Voting from terra feeder",
      chain_id: chainID,
      account_number: account.account_number,
      sequence: account.sequence,
      fees: [{ amount: "0", denom: "mluna" }],
      gas_prices: [{ amount: "300", denom: "mluna" }],
      gas: "200000",
      gas_adjustment: "0",
      simulate: false
    },
    price
  };
  
  const denom = "m" + currency.toLowerCase()
  
  var res = await axios.post(util.format(lcdAddress + ENDPOINT_VOTE, denom), args)
  var tx = res.data.value
  
  var signature = wallet.sign(tx, voter, args.base_req)
  var signedTx = wallet.createSignedTx(tx, signature)
  
  var boradcastReq = wallet.createBroadcastBody(signedTx, `sync`)
  
  var res = await axios.post(lcdAddress + ENDPOINT_BROADCAST, boradcastReq)
  if ( res.data.code !== undefined ) {
    console.error("voting failed : " + JSON.stringify(res.data))
  } else {
    console.log(`Voted : ${denom} = ${price},  txhash : ${res.data.txhash}`)
  }
}

async function main() {
  var parser = new ArgumentParser({
    version: '0.1.0',
    addHelp:true,
    description: 'Terra oracle voter',
  });
  
  registCommands(parser)
  var args = parser.parseArgs();
  
  if ( args.subparser_name == "vote" ) {
    const password = args.password || await promptly.password('Enter a passphrase:')
    const validator = keystore.getKey(defaultKeyName, password)

    updateAndVoting(args, validator)
  } else if ( args.subparser_name == "setkey" ) {
    await updateKey()
  }
}

main().catch((reason) => {
  console.error(reason);
})
