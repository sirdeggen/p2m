import { Button, Stack, Typography } from '@mui/material'
import { QRCodeCanvas } from 'qrcode.react'
import { useCallback, useEffect, useState } from 'react'
import { GetPublicKeyArgs, Utils, Random, PublicKey, Transaction, OP, Script, Hash } from '@bsv/sdk'
import { useWallet } from '../context/WalletContext'
import { toast } from 'react-toastify'
import { MNEEUtxo, Inscription } from 'mnee'
import { MNEETokenInstructions } from '../mnee/MNEE'

const mneeApiToken = '92982ec1c0975f31979da515d46bae9f';
const mneeApi = 'https://proxy-api.mnee.net';
const prodTokenId = 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0';
const prodApprover = '020a177d6a5e6f3a8689acd2e313bd1cf0dcf5a243d1cc67b7218602aee9e04b2f';
const prodAddress = '1inHbiwj2jrEcZPiSYnfgJ8FmS1Bmk4Dh';
const devTokenId = '833a7720966a2a435db28d967385e8aa7284b6150ebb39482cc5228b73e1703f_0';
const devAddress = '1A1QNEkLuvAALsmG4Me3iubP8zb5C6jpv5';
const qaTokenId = '55cde0733049a226fdb6abc387ee9dcd036e859f7cbc69ab90050c0435139f00_0';
const qaAddress = '1BW7cejD27vDLiHsbK1Hvf1y4JTKvC1Yue';
const stageTokenId = '833a7720966a2a435db28d967385e8aa7284b6150ebb39482cc5228b73e1703f_0';
const stageAddress = '1AZNdbFYBDFTAEgzZMfPzANxyNrpGJZAUY';
const gorillaPoolApi = 'https://ordinals.1sat.app';

export const parseInscription = (script: Script) => {
    let fromPos: number | undefined;
    for (let i = 0; i < script.chunks.length; i++) {
      const chunk = script.chunks[i];
      if (
        i >= 2 &&
        chunk.data?.length === 3 &&
        Utils.toUTF8(chunk.data) == 'ord' &&
        script.chunks[i - 1].op == OP.OP_IF &&
        script.chunks[i - 2].op == OP.OP_FALSE
      ) {
        fromPos = i + 1;
      }
    }
    if (fromPos === undefined) return;
  
    const insc = {
      file: { hash: '', size: 0, type: '' },
      fields: {},
    } as Inscription;
  
    for (let i = fromPos; i < script.chunks.length; i += 2) {
      const field = script.chunks[i];
      if (field.op == OP.OP_ENDIF) {
        break;
      }
      if (field.op > OP.OP_16) return;
      const value = script.chunks[i + 1];
      if (value.op > OP.OP_PUSHDATA4) return;
  
      if (field.data?.length) continue;
  
      let fieldNo = 0;
      if (field.op > OP.OP_PUSHDATA4 && field.op <= OP.OP_16) {
        fieldNo = field.op - 80;
      } else if (field.data?.length) {
        fieldNo = field.data[0];
      }
      switch (fieldNo) {
        case 0:
          insc.file!.size = value.data?.length || 0;
          if (!value.data?.length) break;
          insc.file!.hash = Utils.toBase64(Hash.sha256(value.data));
          insc.file!.content = value.data;
          break;
        case 1:
          insc.file!.type = Utils.toUTF8(value.data || []);
          break;
      }
    }
  
    return insc;
  };

function FundMetanet() {
    const { wallet, tokens } = useWallet()
    const [customInstructions, setCustomInstructions] = useState<MNEETokenInstructions | null>(null)
    const [address, setAddress] = useState<string>('')

    const getUtxos = async (address: string) => {
        try {
            const response = await fetch(`${mneeApi}/v1/utxos?auth_token=${mneeApiToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([address]),
          });
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
          const data: MNEEUtxo[] = await response.json()
          console.log({ data })
          return data
        } catch (error) {
            toast.error('Failed to fetch UTXOs')
            return []
        }
    }

    const parseUnitsFromRecentUtxos = async (recent: MNEEUtxo) => {
        const beef = await (await fetch(`${gorillaPoolApi}/v5/tx/${recent.txid}/beef`)).arrayBuffer()
        const bufferArray = new Uint8Array(beef)
        const atomicBEEF = Array.from(bufferArray)
        const tx = Transaction.fromAtomicBEEF(atomicBEEF)
        const valid = await tx.verify()
        if (!valid) toast.error('Invalid transaction was retrieved, did not pass SPV')
        let units = 0
        tx.outputs.map((output, vout) => {
            if (vout !== recent.vout) return
            const insc = parseInscription(output.lockingScript)
            const content = insc?.file?.content
            if (!content) return
            const inscriptionData = Utils.toUTF8(content)
            if (!inscriptionData) return
            const inscriptionJson = JSON.parse(inscriptionData)
            if (prodTokenId !== inscriptionJson.id) return
            if (inscriptionJson.op !== 'transfer') return
            units += parseInt(inscriptionJson.amt)
        })
        return { units, atomicBEEF }
    }

    const getFundingAddress = useCallback(async () => {
        try {
            if (!await wallet.isAuthenticated()) return
            console.log('attempting to fund wallet')
            const instructions = {
                protocolID: [2, 'Pay MNEE'],
                keyID: 'test',
                counterparty: 'self'
            } as GetPublicKeyArgs
            setCustomInstructions(instructions as MNEETokenInstructions)
            const { publicKey } = await wallet.getPublicKey(instructions)
            const a = PublicKey.fromString(publicKey).toAddress()
            setAddress(a)
            console.log({ a })
        } catch (error) {
            console.error('Failed to get funding address:', error)
        }
    }, [wallet])

    const listenForFundsAndInteralize = useCallback(async () => {
        try {
            if (!await wallet.isAuthenticated()) return
            console.log('listening for funds', address)
            const recent = await getUtxos(address)
            await Promise.all(recent.map(async (r) => {
              const { units, atomicBEEF } = await parseUnitsFromRecentUtxos(r)
              if (units === 0) throw new Error('No MNEE tokens found')
              if (!atomicBEEF) throw new Error('Failed to parse transaction')
              const { accepted } = await wallet.internalizeAction({
                  tx: atomicBEEF,
                  description: 'Receive MNEE tokens',
                  labels: ['MNEE'],
                  outputs: [{
                      outputIndex: r.vout,
                      protocol: 'basket insertion',
                      insertionRemittance: {
                          basket: 'MNEE tokens',
                          customInstructions: JSON.stringify(customInstructions),
                          tags: ['MNEE']
                      }
                  }]
              })
              if (!accepted) toast.error('Metanet Desktop rejected a transaction')
              else toast.success(`Funds received: ${units / 100000} MNEE`)
            }))
        } catch (error) {
            console.error('Failed to listen for funds:', error)
        }
    }, [wallet, address, customInstructions])

    return (
        <Stack direction="column" alignItems="center" justifyContent="space-between" spacing={3}>
            {!address 
            ? <Button onClick={getFundingAddress}>Create Deposit Address</Button> 
            : <>
                <Typography variant="subtitle1">Send MNEE to your Metanet Wallet</Typography>
                <QRCodeCanvas value={address} size={160} />
                <Typography variant="overline">Only Send MNEE</Typography>
                <Button onClick={listenForFundsAndInteralize}>Check For Incoming Funds</Button>
            </>}
        </Stack>
    )
}

export default FundMetanet
