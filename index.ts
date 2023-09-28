import { Connection, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js'
import {
	FindNftsByUpdateAuthorityOutput,
	Metadata,
	Metaplex,
	Nft,
	PublicKey,
	Sft,
	keypairIdentity,
} from '@metaplex-foundation/js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import PQueue from 'p-queue'
dotenv.config()

const devWallet = Uint8Array.from(JSON.parse(process.env.DEV_KEYPAIR!))
const devWalletKey = Keypair.fromSecretKey(devWallet)

const connection = new Connection(process.env.BACKEND_RPC!, 'processed')
const metaplex = new Metaplex(connection).use(keypairIdentity(devWalletKey))

export const ruleSet = new PublicKey('eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9')
export const TokenMetadataProgramId = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

try {
	console.log('starting')

	const filePath = 'traitNfts.json'
	const mints = readFromFile(filePath)

	let nfts: any
	if (mints.length === 0) {
		nfts = await metaplex.nfts().findAllByUpdateAuthority({ updateAuthority: devWalletKey.publicKey })
		writeToFile(
			filePath,
			nfts.map((n: any) => n.mintAddress.toBase58())
		)
	} else nfts = await metaplex.nfts().findAllByMintList({ mints })

	console.log(`${nfts.length} nfts found`)

	const concurrencyLimit = 20 // Set your desired concurrency limit
	await processNFTs(nfts, concurrencyLimit)
} catch (error) {
	console.log(error)
}

async function processNFTs(nfts: FindNftsByUpdateAuthorityOutput, concurrencyLimit: number) {
	const updateAuthorities = {
		YC: '6x7rUQwSH7R36kJHAR8kL9sD7ts3FXC6xbvmoCnnmwbN',
		KK: 'BhJr628K8R1sDLj2fSmwXNiUnHEVuMErQT14b4zhMUFA',
	}
	const queue = new PQueue({ concurrency: concurrencyLimit })
	const instructionsPerTxn: TransactionInstruction[][] = []

	async function processNFT(nft: Metadata | Nft | Sft) {
		const mintAddress = (nft as any).mintAddress

		const data = {
			jsonrpc: '2.0',
			id: 1,
			method: 'getProgramAccounts',
			params: [
				TOKEN_PROGRAM_ID.toBase58(),
				{
					encoding: 'jsonParsed',
					filters: [
						{
							dataSize: 165,
						},
						{
							memcmp: {
								offset: 0,
								bytes: mintAddress.toBase58(),
							},
						},
					],
				},
			],
		}

		const response = await fetch(process.env.BACKEND_RPC!, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(data),
		})

		const { result } = await response.json()
		let tokenAccount: PublicKey
		if (!result) {
			const accounts = await connection.getProgramAccounts(
				TOKEN_PROGRAM_ID, // new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
				{
					dataSlice: {
						offset: 0, // number of bytes
						length: 0, // number of bytes
					},
					filters: [
						{
							dataSize: 165, // number of bytes
						},
						{
							memcmp: {
								offset: 0, // number of bytes
								bytes: mintAddress.toBase58(), // base58 encoded string
							},
						},
					],
				}
			)
			if (!accounts?.length) return console.log(`no token accounts found for ${mintAddress.toBase58()}`)
			tokenAccount = accounts[0].pubkey
		} else {
			const currentTokenAccount = (result as any[]).find(
				(a) => a.account.data.parsed.info.tokenAmount.uiAmount === 1
			)
			if (!currentTokenAccount?.pubkey) return console.log(`no token account found for ${mintAddress.toBase58()}`)
			tokenAccount = new PublicKey(currentTokenAccount.pubkey)
		}

		if (!(nft.symbol === 'YC' || nft.symbol == 'KK')) return console.log(`invalid symbol ${nft.symbol}`)
		const newUpdateAuthority = new PublicKey(updateAuthorities[nft!.symbol as 'YC' | 'KK'])
		const instructions = metaplex
			.nfts()
			.builders()
			.update({
				nftOrSft: {
					...(nft as any),
					address: mintAddress,
				},
				newUpdateAuthority,
				...(nft!.tokenStandard === 4
					? {
							ruleSet,
							authorizationDetails: { rules: ruleSet },
					  }
					: {}),
			})
			.getInstructions()

		if (nft!.tokenStandard === 4)
			instructions[0].keys.splice(2, 1, {
				pubkey: tokenAccount,
				isSigner: false,
				isWritable: false,
			})

		instructionsPerTxn.push(instructions)
	}

	await Promise.all(nfts.map((nft) => queue.add(() => processNFT(nft))))

	for (let i = 0; i < instructionsPerTxn.length; i += 2) {
		const txn = new Transaction()
		txn.feePayer = devWalletKey.publicKey
		txn.recentBlockhash = (await connection.getLatestBlockhash('processed')).blockhash

		txn.add(...instructionsPerTxn[i])

		if (i + 1 < instructionsPerTxn.length) txn.add(...instructionsPerTxn[i + 1])

		try {
			txn.partialSign(devWalletKey)
			connection.sendRawTransaction(txn.serialize())
		} catch (error) {
			console.log(error)
		}
		if (i % 10 === 0) {
			console.log(`sent ${i} transactions`)
			await new Promise((resolve) => setTimeout(resolve, 5000))
		}
	}
}

function readFromFile(filePath: string) {
	try {
		const jsonData = fs.readFileSync(filePath, 'utf8')
		const data = JSON.parse(jsonData)
		return data
	} catch (error) {
		console.error('Error reading from file:', error)
	}
}

function writeToFile(filePath: string, data: string[]) {
	try {
		const jsonData = JSON.stringify(data, null, 2)
		fs.writeFileSync(filePath, jsonData)
		console.log('Data written to file successfully.')
	} catch (error) {
		console.error('Error writing to file:', error)
	}
}
