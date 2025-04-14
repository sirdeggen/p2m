import AmountSelector from '../components/AmountSelector'
import { useState, useCallback } from 'react'
import { useWallet } from '../context/WalletContext'
import { toast } from 'react-toastify'
import IdentitySelector from '../components/IdentitySelector'
import { Button, Typography, Stack } from '@mui/material'
import { Identity } from '@bsv/identity-react'

export default function P2Identity () {
    const [amount, setAmount] = useState<number>(0)
    const { wallet, tokens, balance, mnee } = useWallet()
    const [selectedIdentity, setSelectedIdentity] = useState<Identity | null>(null)
  
    const pay = useCallback(async () => {
      if (amount <= 0) {
        toast.error('Amount must be greater than 0')
        return
      }

      const units = amount * 100000
      if (balance < units + 1000) {
        toast.error('Insufficient balance')
        return
      }
      console.log('Pay', selectedIdentity?.identityKey, amount) 
      try {
        const paid = await mneePeerPayClient.sendPayment(tokens, selectedIdentity!.identityKey, units)
        if (paid) {
          console.log({ paid })
          toast.success('Payment sent successfully')
        } else {
          toast.error('Failed to send payment')
        }
      } catch (error) {
        toast.error('Failed to send payment')
        console.error({ error })
      }
    }, [selectedIdentity, amount, wallet, tokens, mneePeerPayClient])
    
    return (<Stack direction="column" alignItems="center" justifyContent="space-between" spacing={3} sx={{ pb: 5 }}>
      <Typography textAlign='center' variant="caption" color="text.secondary">Send MNEE to a certified identity.</Typography>
      <IdentitySelector selectedIdentity={selectedIdentity} setSelectedIdentity={setSelectedIdentity} />
      <AmountSelector setAmount={setAmount} />
      <Button onClick={pay} variant="contained" color="primary" disabled={amount === 0 || !selectedIdentity}>Send</Button>
    </Stack>)
}