import { storage } from '../Storage'


const utcNow = () => Math.floor(Date.now() / 1000)
const getLockTime = () => utcNow() + 3600 * 3 // 3 days from now


class BtcSwap {

  constructor() {
    const { lib, fetchUnspents } = storage.btcConfig

    this.bitcoin        = lib
    this.fetchUnspents  = fetchUnspents
  }

  createScript({ secretHash, btcOwnerPublicKey, ethOwnerPublicKey, lockTime: _lockTime }) {
    console.log('\n\nCreate BTC Swap Script', { secretHash, btcOwnerPublicKey, ethOwnerPublicKey, lockTime: _lockTime })

    const lockTime = _lockTime || getLockTime()

    // const script = this.bitcoin.script.compile([
    //   this.bitcoin.opcodes.OP_RIPEMD160,
    //   Buffer.from(secretHash, 'hex'),
    //   this.bitcoin.opcodes.OP_EQUALVERIFY,
    //   Buffer.from(ethOwnerPublicKey, 'hex'),
    //   this.bitcoin.opcodes.OP_CHECKSIG,
    // ])

    const script = this.bitcoin.script.compile([
      this.bitcoin.opcodes.OP_RIPEMD160,
      Buffer.from(secretHash, 'hex'),
      this.bitcoin.opcodes.OP_EQUALVERIFY,

      Buffer.from(ethOwnerPublicKey, 'hex'),
      this.bitcoin.opcodes.OP_EQUAL,
      this.bitcoin.opcodes.OP_IF,

      Buffer.from(ethOwnerPublicKey, 'hex'),
      this.bitcoin.opcodes.OP_CHECKSIG,

      this.bitcoin.opcodes.OP_ELSE,

      this.bitcoin.script.number.encode(lockTime),
      this.bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
      this.bitcoin.opcodes.OP_DROP,
      Buffer.from(btcOwnerPublicKey, 'hex'),
      this.bitcoin.opcodes.OP_CHECKSIG,

      this.bitcoin.opcodes.OP_ENDIF,
    ])

    const scriptPubKey    = this.bitcoin.script.scriptHash.output.encode(this.bitcoin.crypto.hash160(script))
    const scriptAddress   = this.bitcoin.address.fromOutputScript(scriptPubKey, this.bitcoin.testnet)

    console.log('BTC Swap created', {
      script,
      scriptAddress,
    })

    return {
      script,
      address: scriptAddress,
      secretHash,
      lockTime,
      btcOwnerPublicKey,
      ethOwnerPublicKey,
    }
  }

  fundScript({ btcData, script, amount }) {
    console.log('\n\nFund BTC Swap Script', { btcData, script, amount })

    return new Promise(async (resolve, reject) => {
      // const script        = hexStringToByte(scriptHash)
      try {
        const scriptPubKey  = this.bitcoin.script.scriptHash.output.encode(this.bitcoin.crypto.hash160(script))
        const scriptAddress = this.bitcoin.address.fromOutputScript(scriptPubKey, this.bitcoin.testnet)

        const tx            = new this.bitcoin.TransactionBuilder(this.bitcoin.testnet)
        const unspents      = await this.fetchUnspents(btcData.address)

        const fundValue     = Math.floor(Number(amount) * 1e8)
        const feeValue      = 4e5
        const totalUnspent  = unspents.reduce((summ, { satoshis }) => summ + satoshis, 0)
        const skipValue     = totalUnspent - fundValue - feeValue

        console.log('Data', { totalUnspent, fundValue, feeValue, skipValue, tx, scriptAddress })

        unspents.forEach(({ txid, vout }) => {
          tx.addInput(txid, vout)
        })
        tx.addOutput(scriptAddress, fundValue)
        tx.addOutput(btcData.address, skipValue)
        tx.inputs.forEach((input, index) => {
          tx.sign(index, btcData.keyPair)
        })

        const txRaw     = tx.buildIncomplete()
        const txRawHex  = txRaw.toHex()

        console.log('tx', tx)
        console.log('txRawHex', txRawHex)

        const result = await this.bitcoin.broadcastTx(txRawHex)

        resolve(result)
      }
      catch (err) {
        reject(err)
      }
    })
  }

  withdraw({ btcData, script, secret }) {
    console.log('\n\nWithdraw money from BTC Swap Script', { btcData, script, secret })

    return new Promise(async (resolve, reject) => {
      try {
        const scriptPubKey  = this.bitcoin.script.scriptHash.output.encode(this.bitcoin.crypto.hash160(script))
        const scriptAddress = this.bitcoin.address.fromOutputScript(scriptPubKey, this.bitcoin.testnet)

        const hashType      = this.bitcoin.Transaction.SIGHASH_ALL
        const tx            = new this.bitcoin.TransactionBuilder(this.bitcoin.testnet)

        const unspents      = await this.fetchUnspents(scriptAddress)

        const feeValue      = 4e5
        const totalUnspent  = unspents.reduce((summ, { satoshis }) => summ + satoshis, 0)

        unspents.forEach(({ txid, vout }) => {
          tx.addInput(txid, vout, 0xfffffffe)
        })
        tx.addOutput(btcData.address, totalUnspent - feeValue)

        const txRaw               = tx.buildIncomplete()
        const signatureHash       = txRaw.hashForSignature(0, script, hashType)
        const signature           = btcData.account.sign(signatureHash).toScriptSignature(hashType)

        const scriptSig = this.bitcoin.script.scriptHash.input.encode(
          [
            signature,
            btcData.account.getPublicKeyBuffer(),
            Buffer.from(secret.replace(/^0x/, ''), 'hex'),
          ],
          script,
        )

        txRaw.setInputScript(0, scriptSig)

        const txId      = txRaw.getId()
        const txRawHex  = txRaw.toHex()

        console.log('txId', txId)
        console.log('txRawHex', txRawHex)

        const result = await this.bitcoin.broadcastTx(txRawHex)

        resolve(result)
      }
      catch (err) {
        reject(err)
      }
    })
  }

  refund({ btcData, script, lockTime, secret }, handleTransactionHash) {
    console.log('\n\nRefund money from BTC Swap Script')

    return new Promise(async (resolve, reject) => {
      try {
        const scriptPubKey  = this.bitcoin.script.scriptHash.output.encode(this.bitcoin.crypto.hash160(script))
        const scriptAddress = this.bitcoin.address.fromOutputScript(scriptPubKey, this.bitcoin.testnet)

        const hashType      = this.bitcoin.Transaction.SIGHASH_ALL
        const tx            = new this.bitcoin.TransactionBuilder(this.bitcoin.testnet)

        const unspents      = await this.fetchUnspents(scriptAddress)

        const feeValue      = 4e5
        const totalUnspent  = unspents.reduce((summ, { satoshis }) => summ + satoshis, 0)

        tx.setLockTime(lockTime)
        unspents.forEach(({ txid, vout }) => {
          tx.addInput(txid, vout, 0xfffffffe)
        })
        tx.addOutput(btcData.address, totalUnspent - feeValue)

        const txRaw               = tx.buildIncomplete()
        const signatureHash       = txRaw.hashForSignature(0, script, hashType)
        const signature           = btcData.account.sign(signatureHash).toScriptSignature(hashType)

        const scriptSig = this.bitcoin.script.scriptHash.input.encode(
          [
            signature,
            btcData.account.getPublicKeyBuffer(),
            Buffer.from(secret, 'hex'),
          ],
          script,
        )

        txRaw.setInputScript(0, scriptSig)

        const txId      = txRaw.getId()
        const txRawHex  = txRaw.toHex()

        console.log('txId', txId)
        console.log('txRawHex', txRawHex)

        const result = await this.bitcoin.broadcastTx(txRawHex)

        handleTransactionHash && handleTransactionHash(txId)
        resolve(result)
      }
      catch (err) {
        reject(err)
      }
    })
  }
}


export default BtcSwap
