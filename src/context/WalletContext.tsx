import React, { useCallback, useEffect, useState } from "react"
import { WalletClient, ListOutputsResult } from "@bsv/sdk"
import Mnee, { ParseTxResponse } from "mnee"
import { useContext } from "react"

export type WalletContextValue = {
    wallet: WalletClient
    mnee: Mnee
    balance: number
    tokens: ListOutputsResult | null
    setBalance: (balance: number) => void
    setTokens: (tokens: ListOutputsResult | null) => void
}

const WalletContext = React.createContext<WalletContextValue>({
    wallet: new WalletClient(),
    mnee: new Mnee(),
    balance: 0,
    setBalance: () => {},
    tokens: null,
    setTokens: () => {}
})

export function useWallet() {
    return useContext<WalletContextValue>(WalletContext)
}

export const WalletProvider = ({ children }: { children: React.ReactNode }) => {
    const wallet = new WalletClient()
    const mnee = new Mnee()
    const [balance, setBalance] = useState<number>(0)
    const [tokens, setTokens] = useState<ListOutputsResult | null>(null)

    return (
        <WalletContext.Provider value={{ wallet, mnee, balance, tokens, setBalance, setTokens }}>
            {children}
        </WalletContext.Provider>
    )
}