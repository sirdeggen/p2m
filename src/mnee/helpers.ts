import { Transaction, Utils, Beef, WalletInterface, ListOutputsResult } from "@bsv/sdk";
import { TokenTransfer, MNEETokenInstructions } from '../mnee/TokenTransfer'
import { parseInscription } from "../pages/FundMetanet"

const mneeApiToken = import.meta.env.VITE_MNEE_API_TOKEN
const mneeApi = import.meta.env.VITE_MNEE_API
const feeAddress = import.meta.env.VITE_FEE_ADDRESS as string
const gorillaPoolApi = import.meta.env.VITE_GORILLA_POOL_API

// export const prodApprover = '020a177d6a5e6f3a8689acd2e313bd1cf0dcf5a243d1cc67b7218602aee9e04b2f'
// export const prodAddress = '1inHbiwj2jrEcZPiSYnfgJ8FmS1Bmk4Dh'
// export const prodTokenId = 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0'
// export const mneeApi = 'https://proxy-api.mnee.net'
// export const mneeApiToken = '92982ec1c0975f31979da515d46bae9f'
// export const gorillaPoolApi = 'https://ordinals.1sat.app'
// export const feeAddress = '19Vq2TV8aVhFNLQkhDMdnEQ7zT96x6F3PK'

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
    if (unitsIn >= units + 1000) break 
    const [txid, vout] = token.outpoint.split('.')
    const beef = Beef.fromBinary(tokens.BEEF as number[])
    const sourceTransaction = beef.findAtomicTransaction(txid)
    if (!sourceTransaction) {
      console.error('Failed to find source transaction')
      return { tx, error: 'Failed to find source transaction' }
    }
    // for the output of the sourceTransaction, check the MNEE amt value
    const output = sourceTransaction.outputs[parseInt(vout)]
    const inscription = parseInscription(output.lockingScript)
    unitsIn += parseInt(inscription?.amt || '0')
    console.log({ token, inscription })
    const customInstructions = JSON.parse(token?.customInstructions ?? '{}') as MNEETokenInstructions
    tx.addInput({
      sourceTXID: txid,
      sourceOutputIndex: parseInt(vout),
      sourceTransaction,
      unlockingScriptTemplate: new TokenTransfer().unlock(wallet, customInstructions, 'all', true), // ANYONECANPAY
    })
  }
  const fee = (unitsIn >= 1000001) ? 1000 : 100

  console.log({ unitsIn, units })
  if (unitsIn < units + fee) {
    return { tx, error: 'Insufficient MNEE tokens to spend' }
  }

  const remainder = unitsIn - units - fee

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

  // this output is to pay the issuer
  tx.addOutput({
    lockingScript: new TokenTransfer().lock(feeAddress, fee),
    satoshis: 1
  })

  // get signatures from Metanet Desktop
  await tx.sign()

  return { tx, error: false }
}

export const cosignBroadcast = async (tx: Transaction) => {
  console.log({ tx: tx.toHex() })
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
