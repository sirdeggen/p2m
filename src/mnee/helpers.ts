import { Transaction, Utils } from "@bsv/sdk";
import { TokenTransfer } from '../mnee/TokenTransfer'
import { WalletInterface } from "@bsv/sdk";
import { ListOutputsResult } from "@bsv/sdk";
import { parseInscription } from "../pages/FundMetanet";
import { MNEETokenInstructions } from "../mnee/TokenTransfer";

export const prodApprover = '020a177d6a5e6f3a8689acd2e313bd1cf0dcf5a243d1cc67b7218602aee9e04b2f'
export const prodAddress = '1inHbiwj2jrEcZPiSYnfgJ8FmS1Bmk4Dh'
export const prodTokenId = 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0'
export const mneeApi = 'https://proxy-api.mnee.net'
export const mneeApiToken = '92982ec1c0975f31979da515d46bae9f'
export const gorillaPoolApi = 'https://ordinals.1sat.app'
export const fees = [
  {
    "min": 0,
    "max": 1000000,
    "fee": 100
  },
  {
    "min": 1000001,
    "max": 9007199254740991,
    "fee": 1000
  }
]

export const fetchBeef = async (txid: string): Promise<number[]> => {
  const beef = await (await fetch(`${gorillaPoolApi}/v5/tx/${txid}/beef`)).arrayBuffer()
  const bufferArray = new Uint8Array(beef)
  return Array.from(bufferArray)
}

export const createTx = async (
  wallet: WalletInterface,
  tokens: ListOutputsResult,
  address: string,
  units: number,
  changeAddress: string): Promise<{ tx: Transaction, error: string | false }> => {
  const tx = new Transaction()
  let unitsIn = 0

  // do we have any MNEE?
  if (tokens.outputs.length === 0) {
    return { tx, error: 'No MNEE tokens to spend' }
  }

  // do we have enough to cover what we're sending and fee?
  for (const token of tokens.outputs) {
    if (unitsIn >= units) break
    const [txid, vout] = token.outpoint.split('.')
    const sourceTransaction = Transaction.fromBEEF(tokens.BEEF as number[])
    // for the output of the sourceTransaction, check the MNEE amt value
    const output = sourceTransaction.outputs[parseInt(vout)]
    const inscription = parseInscription(output.lockingScript)
    unitsIn += parseInt(inscription?.amt || '0')
    const customInstructions = JSON.parse(token?.customInstructions || '{}') as MNEETokenInstructions
    tx.addInput({
      sourceTXID: txid,
      sourceOutputIndex: parseInt(vout),
      sourceTransaction,
      unlockingScriptTemplate: new TokenTransfer().unlock(wallet, customInstructions, 'all', true), // ANYONECANPAY
    })
  }

  if (unitsIn < units) {
    return { tx, error: 'Insufficient MNEE tokens to spend' }
  }

  const remainder = unitsIn - units

  // pay the person you're trying to pay
  tx.addOutput({
    lockingScript: new TokenTransfer().lock(address, units),
    satoshis: 1
  })

  // keep the change yourself.
  tx.addOutput({
    satoshis: 1,
    lockingScript: new TokenTransfer().lock(changeAddress, remainder)
  })

  const fee = (unitsIn >= 1000001) ? 1000 : 100

  // this output is to pay the issuer
  tx.addOutput({
    lockingScript: new TokenTransfer().lock(prodAddress, fee),
    satoshis: 1
  })

  // get signatures from Metanet Desktop
  await tx.sign()

  return { tx, error: false }
}

export const cosignBroadcast = async (tx: Transaction) => {
  const base64Tx = Utils.toBase64(tx.toBinary())
  const response = await fetch(`${mneeApi}/v1/transfer?auth_token=${mneeApiToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawtx: base64Tx }),
  })
  if (!response.ok) return { error: new Error(`HTTP error! status: ${response.status}`) }
  const { rawtx: responseRawtx } = await response.json()
  if (!responseRawtx) return { error: new Error('Failed to broadcast transaction') }
  return { tx: Transaction.fromBinary(Utils.toArray(responseRawtx, 'base64')), error: false }
}
