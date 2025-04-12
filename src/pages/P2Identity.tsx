import AmountSelector from '../components/AmountSelector'
import { useState, useCallback } from 'react'
import { useWallet } from '../context/WalletContext'
import { toast } from 'react-toastify'
import IdentitySelector from '../components/IdentitySelector'
import { Button } from '@mui/material'
import { Identity } from '@bsv/identity-react'

export default function P2Identity () {
    const [amount, setAmount] = useState<number>(0)
    const { wallet } = useWallet()
    const [selectedIdentity, setSelectedIdentity] = useState<Identity | null>(null)
  
    const pay = useCallback(async () => {
      if (amount <= 0) {
        toast.error('Amount must be greater than 0')
        return
      }
      console.log('Pay', selectedIdentity?.identityKey, amount)
      // first we have to get the current user's MNEE tokens by checking their basket
      await wallet.waitForAuthentication()
      const tokens = await wallet.listOutputs({
        basket: 'MNEE tokens'
      })
      console.log('Tokens', tokens)
    }, [selectedIdentity, amount, wallet])
    
    return (<>
      <IdentitySelector selectedIdentity={selectedIdentity} setSelectedIdentity={setSelectedIdentity} />
      <AmountSelector setAmount={setAmount} />
      <Button onClick={pay} variant="contained" color="primary" disabled={amount === 0 || !selectedIdentity}>Pay</Button>
    </>)
}