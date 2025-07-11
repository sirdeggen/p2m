import { MessageBoxClient, PeerMessage } from '@bsv/message-box-client'
import { WalletClient, Utils, PublicKey, AtomicBEEF, Base64String, Beef, ListOutputsResult, Transaction, OutpointString } from '@bsv/sdk'
import { Logger } from './Logger.js'
import { MNEETokenInstructions, TokenTransfer } from '../mnee/TokenTransfer.js'
import { parseInscription } from '../pages/FundMetanet.js'
import { MNEE_PROXY_API_URL, PROD_ADDRESS, PUBLIC_PROD_MNEE_API_TOKEN } from '../mnee/constants'

export const MNEE_PAYMENT_MESSAGEBOX = 'mnee_payment_inbox'

/**
 * Configuration options for initializing PeerPayClient.
 */
export interface PeerPayClientConfig {
  messageBoxHost?: string
  walletClient: WalletClient
  enableLogging?: boolean  // 🔹 Added optional logging flag
}

/**
 * Represents a structured payment token.
 */
export interface PaymentToken {
  keyID: Base64String,
  originator: string,
  beneficiary: string,
  transaction: AtomicBEEF,
  units: number
}

/**
 * Represents an incoming payment received via MessageBox.
 */
export interface IncomingPayment {
  messageId: string
  token: PaymentToken
}

/**
 * PeerPayClient enables peer-to-peer Bitcoin payments using MessageBox.
 */
export class MneePeerPayClient extends MessageBoxClient {
  private readonly peerPayWalletClient: WalletClient

  constructor(config: PeerPayClientConfig) {
    const { messageBoxHost = 'https://message-box-us-1.bsvb.tech', walletClient, enableLogging = false } = config

    // 🔹 Pass enableLogging to MessageBoxClient
    super({ host: messageBoxHost, walletClient, enableLogging })

    this.peerPayWalletClient = walletClient
  }

  static async fetchBeef(txid: string): Promise<number[]> {
    const beef = await (await fetch(`${MNEE_PROXY_API_URL}/v5/tx/${txid}/beef`)).arrayBuffer()
    const bufferArray = new Uint8Array(beef)
    return Array.from(bufferArray)
  }

  async createTx(
    tokens: ListOutputsResult,
    beneficiary: string,
    units: number
  ): Promise<{ tokensOnlyTx: Transaction, tx: Transaction, keyID: Base64String }> {
    const tx = new Transaction()
    let unitsIn = 0
  
    // do we have any MNEE?
    if (tokens.outputs.length === 0) {
      throw new Error('No MNEE tokens to spend')
    }
  
    // do we have enough to cover what we're sending and fee?
    for (const token of tokens.outputs) {
      if (unitsIn >= units + 1000) break 
      const [txid, vout] = token.outpoint.split('.')
      const beef = Beef.fromBinary(tokens.BEEF as number[])
      const sourceTransaction = beef.findAtomicTransaction(txid)
      if (!sourceTransaction) {
        console.error('Failed to find source transaction')
        throw new Error('Failed to find source transaction')
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
        unlockingScriptTemplate: new TokenTransfer().unlock(this.peerPayWalletClient, customInstructions, 'all', true), // ANYONECANPAY
      })
    }
    const fee = (unitsIn >= 1000001) ? 1000 : 100
  
    if (unitsIn < units + fee) {
      throw new Error('Insufficient MNEE tokens to spend')
    }
  
    const remainder = unitsIn - units - fee

    const keyID = Utils.toBase64(Utils.toArray(new Date().toISOString().slice(0,16), 'utf8'))

    const { publicKey: beneficiaryKey } = await this.peerPayWalletClient.getPublicKey({
      protocolID: [2, 'Pay MNEE'],
      keyID,
      counterparty: beneficiary
    })

    const { publicKey: originatorKey } = await this.peerPayWalletClient.getPublicKey({
      protocolID: [2, 'Pay MNEE'],
      keyID,
      counterparty: 'self'
    })
  
    // pay the person you're trying to pay
    tx.addOutput({
      lockingScript: new TokenTransfer().lock(PublicKey.fromString(beneficiaryKey).toAddress(), units),
      satoshis: 1
    })
  
    // keep the change yourself.
    tx.addOutput({
      satoshis: 1,
      lockingScript: new TokenTransfer().lock(PublicKey.fromString(originatorKey).toAddress(), remainder)
    })
  
    // this output is to pay the issuer
    tx.addOutput({
      lockingScript: new TokenTransfer().lock(PROD_ADDRESS, fee),
      satoshis: 1
    })
  
    // get signatures from Metanet Desktop
    await tx.sign()
  
    const base64Tx = Utils.toBase64(tx.toBinary())
    const response = await fetch(`${MNEE_PROXY_API_URL}/v1/transfer?auth_token=${PUBLIC_PROD_MNEE_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawtx: base64Tx }),
    })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    const { rawtx: responseRawtx } = await response.json()
    if (!responseRawtx) throw new Error('Failed to broadcast transaction')
    return { tokensOnlyTx: tx, tx: Transaction.fromBinary(Utils.toArray(responseRawtx, 'base64')), keyID }
  }

  /**
   * Sends Bitcoin to a PeerPay recipient.
   *
   * This function validates the payment details and delegates the transaction
   * to `sendLivePayment` for processing.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @returns {Promise<any>} Resolves with the payment result.
   * @throws {Error} If the recipient is missing or the amount is invalid.
   */
  async sendPayment(tokens: ListOutputsResult, beneficiary: string, units: number): Promise<any> {
    if (beneficiary == null || beneficiary.trim() === '' || units <= 0) {
      throw new Error('Invalid payment details: beneficiary and valid units are required')
    }

    const { tokensOnlyTx, tx, keyID } = await this.createTx(tokens, beneficiary, units)
    if (!tx || !keyID) {
      throw new Error('Failed to create transaction')
    }

    const { publicKey: originator } = await this.peerPayWalletClient.getPublicKey({ identityKey: true })

    // construct an atomic beef from the current txs plus inputs.
    await Promise.all(tx.inputs.map(async input => {
      const txid = input.sourceTXID as string
      const createdInput = tokensOnlyTx.inputs.find(tx => tx.sourceTXID === txid)
      if (createdInput) {
        input.sourceTransaction = createdInput.sourceTransaction
      } else {
        const atomicBeefForThisInput = await MneePeerPayClient.fetchBeef(txid)
        input.sourceTransaction = Transaction.fromAtomicBEEF(atomicBeefForThisInput)
      }
    }))

    const atomicBEEF = tx.toAtomicBEEF()

    const spent = tokensOnlyTx.inputs.map(input => (input.sourceTXID + '.' + input.sourceOutputIndex) as OutpointString)
    await Promise.all(spent.map(async output => {
      const { relinquished } = await this.peerPayWalletClient.relinquishOutput({
        basket: 'MNEE tokens',
        output
      })
      if (!relinquished) {
        console.error('Failed to relinquish output')
      }
    }))
    
    const { accepted } = await this.peerPayWalletClient.internalizeAction({
      tx: atomicBEEF,
      description: 'Receive MNEE tokens',
      labels: ['MNEE'],
      outputs: [{
        outputIndex: 1,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: 'MNEE tokens',
          customInstructions: JSON.stringify({
            protocolID: [2, 'Pay MNEE'],
            keyID,
            counterparty: 'self'
          }),
          tags: ['MNEE']
        }
      }]
    })
    if (!accepted) {
      console.error('Failed to internalize action')
    }

    const payment = {
      keyID,
      originator,
      beneficiary,
      transaction: atomicBEEF,
      units
    }

    // Ensure the recipient is included before sending
    return await this.sendMessage({
      recipient: beneficiary,
      messageBox: MNEE_PAYMENT_MESSAGEBOX,
      body: payment
    })
  }

  /**
   * Sends Bitcoin to a PeerPay recipient over WebSockets.
   *
   * This function generates a payment token and transmits it over WebSockets
   * using `sendLiveMessage`. The recipient’s identity key is explicitly included
   * to ensure proper message routing.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @returns {Promise<void>} Resolves when the payment has been sent.
   * @throws {Error} If payment token generation fails.
   */
  async sendLivePayment(payment: PaymentToken): Promise<void> {
    // Ensure the recipient is included before sending
    await this.sendLiveMessage({
      recipient: payment.beneficiary,
      messageBox: MNEE_PAYMENT_MESSAGEBOX,
      body: payment
    })
  }

  /**
   * Listens for incoming Bitcoin payments over WebSockets.
   *
   * This function listens for messages in the standard payment message box and
   * converts incoming `PeerMessage` objects into `IncomingPayment` objects
   * before invoking the `onPayment` callback.
   *
   * @param {Object} obj - The configuration object.
   * @param {Function} obj.onPayment - Callback function triggered when a payment is received.
   * @returns {Promise<void>} Resolves when the listener is successfully set up.
   */
  async listenForLivePayments({
    onPayment
  }: { onPayment: (payment: IncomingPayment) => void }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: MNEE_PAYMENT_MESSAGEBOX,

      // Convert PeerMessage → IncomingPayment before calling onPayment
      onMessage: (message: PeerMessage) => {
        Logger.log('[MB CLIENT] Received Live Payment:', message);
        const incomingPayment: IncomingPayment = {
          messageId: message.messageId,
          token: JSON.parse(message.body as string)
        }
        Logger.log('[PP CLIENT] Converted PeerMessage to IncomingPayment:', incomingPayment)
        onPayment(incomingPayment)
      }
    })
  }

  /**
   * Accepts an incoming Bitcoin payment and moves it into the default wallet basket.
   *
   * This function processes a received payment by submitting it for internalization
   * using the wallet client's `internalizeAction` method. The payment details
   * are extracted from the `IncomingPayment` object.
   *
   * @param {IncomingPayment} payment - The payment object containing transaction details.
   * @returns {Promise<any>} Resolves with the payment result if successful.
   * @throws {Error} If payment processing fails.
   */
  async acceptPayment(payment: IncomingPayment): Promise<any> {
    try {
      Logger.log(`[PP CLIENT] Processing payment: ${JSON.stringify(payment, null, 2)}`)

      const paymentResult = await this.peerPayWalletClient.internalizeAction({
        tx: payment.token.transaction,
        description: 'Receive MNEE tokens',
        labels: ['MNEE'],
        outputs: [{
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: {
                basket: 'MNEE tokens',
                customInstructions: JSON.stringify({
                    protocolID: [2, 'Pay MNEE'],
                    keyID: payment.token.keyID,
                    counterparty: payment.token.originator
                }),
                tags: ['MNEE']
            }
        }]
    })

      Logger.log(`[PP CLIENT] Payment internalized successfully: ${JSON.stringify(paymentResult, null, 2)}`)
      Logger.log(`[PP CLIENT] Acknowledging payment with messageId: ${payment.messageId}`)

      await this.acknowledgeMessage({ messageIds: [String(payment.messageId)] })

      return { payment, paymentResult }
    } catch (error) {
      Logger.error(`[PP CLIENT] Error accepting payment: ${String(error)}`)
      return 'Unable to receive payment!'
    }
  }

  /**
   * Rejects an incoming Bitcoin payment by refunding it to the sender, minus a fee.
   *
   * If the payment amount is too small (less than 1000 satoshis after deducting the fee),
   * the payment is simply acknowledged and ignored. Otherwise, the function first accepts
   * the payment, then sends a new transaction refunding the sender.
   *
   * @param {IncomingPayment} payment - The payment object containing transaction details.
   * @returns {Promise<void>} Resolves when the payment is either acknowledged or refunded.
   */
  async rejectPayment(_: IncomingPayment): Promise<void> {
    throw new Error('Not implemented yet')
    // Logger.log(`[PP CLIENT] Rejecting payment: ${JSON.stringify(payment, null, 2)}`);
    // Logger.log('[PP CLIENT] Accepting payment before refunding...');
    // await this.acceptPayment(payment);

    // Logger.log(`[PP CLIENT] Sending refund of ${payment.token.amount - 1000} to ${payment.sender}...`);
    // await this.sendPayment({
    //   recipient: payment.sender,
    //   amount: payment.token.amount - 1000 // Deduct fee
    // });

    // Logger.log('[PP CLIENT] Payment successfully rejected and refunded.');

    // try {
    //   Logger.log(`[PP CLIENT] Acknowledging message ${payment.messageId} after refunding...`);
    //   await this.acknowledgeMessage({ messageIds: [String(payment.messageId)] });
    //   Logger.log(`[PP CLIENT] Acknowledgment after refund successful.`);
    // } catch (error: any) {
    //   Logger.error(`[PP CLIENT] Error acknowledging message after refund: ${error.message}`);
    // }
  }

  /**
   * Retrieves a list of incoming Bitcoin payments from the message box.
   *
   * This function queries the message box for new messages and transforms
   * them into `IncomingPayment` objects by extracting relevant fields.
   *
   * @returns {Promise<IncomingPayment[]>} Resolves with an array of pending payments.
   */
  async listIncomingPayments(): Promise<IncomingPayment[]> {
    const messages = await this.listMessages({ messageBox: MNEE_PAYMENT_MESSAGEBOX })

    return messages.map((msg: any) => ({
      messageId: msg.messageId,
      sender: msg.sender,
      token: JSON.parse(msg.body)
    }))
  }
}
