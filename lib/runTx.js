const async = require('async')
const BN = require('bn.js')
const Bloom = require('./bloom.js')
const Block = require('ethereumjs-block')

/**
 * Process a transaction. Run the vm. Transfers eth. checks balaces
 * @method processTx
 * @param opts
 * @param opts.tx {Transaciton} - a transaction
 * @param opts.skipNonce - skips the nonce check
 * @param opts.block {Block} needed to process the transaction, if no block is given a default one is created
 * @param cb {Function} - the callback
 */
module.exports = function (opts, cb) {
  var self = this
  var block = opts.block
  var tx = opts.tx
  var gasLimit
  var results
  var basefee

  // create a reasonable default if no block is given
  if (!block) {
    block = new Block()
    block.header.gasLimit = '0xfffffffffffff'
  }

  if (new BN(block.header.gasLimit).cmp(new BN(tx.gasLimit)) === -1) {
    cb(new Error('tx has a higher gas limit than the block'))
    return
  }

  if (opts.populateCache === undefined) {
    opts.populateCache = true
  }

  // run everything
  async.series([
    populateCache,
    runTxHook,
    runCall,
    saveTries,
    runAfterTxHook,
    function (cb) {
      self.stateManager.cache.flush(function () {
        if (opts.populateCache) {
          self.stateManager.cache.clear()
        }
        cb()
      })
    }
  ], function (err) {
    cb(err, results)
  })

  // run the transaction hook
  function runTxHook (cb) {
    self.emit('beforeTx', tx, cb)
  }

  // run the transaction hook
  function runAfterTxHook (cb) {
    self.emit('afterTx', results, cb)
  }

  /**
   * populates the cache with the two and from of the tx
   */
  function populateCache (cb) {
    var accounts = new Set()
    accounts.add(tx.from.toString('hex'))
    accounts.add(tx.to.toString('hex'))
    accounts.add(block.header.coinbase.toString('hex'))

    if (opts.populateCache === false) {
      return cb()
    }

    self.stateManager.warmCache(accounts, cb)
  }

  // sets up the envorment and runs a `call`
  function runCall (cb) {
    // check to the sender's account to make sure it has enought wei and the
    // correct nonce
    var fromAccount = self.stateManager.cache.get(tx.from)
    var message

    if (new BN(fromAccount.balance).cmp(tx.getUpfrontCost()) === -1) {
      message = "sender doesn't have enough funds to send tx. The upfront cost is: " + tx.getUpfrontCost().toString() + ' and the sender\s account only has: ' + new BN(fromAccount.balance).toString()
      cb(new Error(message))
      return
    } else if (!opts.skipNonce && new BN(fromAccount.nonce).cmp(new BN(tx.nonce)) !== 0) {
      message = "the tx doesn't have the correct nonce. account has nonce of: " + new BN(fromAccount.nonce).toString() + ' tx has nonce of: ' + new BN(tx.nonce).toString()
      cb(new Error(message))
      return
    }

    // increment the nonce
    fromAccount.nonce = new BN(fromAccount.nonce).add(new BN(1))
    basefee = tx.getBaseFee()
    gasLimit = new BN(tx.gasLimit).sub(basefee)
    fromAccount.balance = new BN(fromAccount.balance).sub(new BN(tx.gasLimit).mul(new BN(tx.gasPrice)))
    self.stateManager.cache.put(tx.from, fromAccount)

    var options = {
      caller: tx.from,
      gasLimit: gasLimit,
      gasPrice: tx.gasPrice,
      to: tx.to,
      value: new BN(tx.value),
      data: tx.data,
      block: block,
      populateCache: false
    }

    if (tx.to.toString('hex') === '') {
      delete options.to
    }

    // run call
    self.runCall(options, parseResults)

    function parseResults (err, _results) {
      results = _results

      // generate the bloom for the tx
      results.bloom = txLogsBloom(results.vm.logs)
      fromAccount = self.stateManager.cache.get(tx.from)

      // caculate the totall gas used
      results.gasUsed = results.gasUsed.add(basefee)

      // refund the accoun.stateManagert
      var gasRefund = results.vm.gasRefund
      if (gasRefund) {
        if (gasRefund.cmp(results.gasUsed.divn(2)) === -1) {
          results.gasUsed.isub(gasRefund)
        } else {
          results.gasUsed.isub(results.gasUsed.divn(2))
        }
      }

      results.amountSpent = results.gasUsed.mul(new BN(tx.gasPrice))
      // refund the left over gas amount
      fromAccount.balance = new BN(tx.gasLimit).sub(results.gasUsed)
        .mul(new BN(tx.gasPrice))
        .add(new BN(fromAccount.balance))

      self.stateManager.cache.put(tx.from, fromAccount)

      var minerAccount = self.stateManager.cache.get(block.header.coinbase)
      // add the amount spent on gas to the miner's account
      minerAccount.balance = new BN(minerAccount.balance)
        .add(results.amountSpent)

      // save the miner's account
      self.stateManager.cache.put(block.header.coinbase, minerAccount)

      if (!results.vm.suicides) {
        results.vm.suicides = {}
      }

      var keys = Object.keys(results.vm.suicides)

      keys.forEach(function (s) {
        self.stateManager.cache.del(new Buffer(s, 'hex'))
      })

      cb(err)
    }
  }

  function saveTries (cb) {
    self.stateManager.commitContracts(cb)
  }
}

/**
 * @method txLogsBloom
 */
function txLogsBloom (logs) {
  var bloom = new Bloom()
  if (logs) {
    for (var i = 0; i < logs.length; i++) {
      var log = logs[i]
      // add the address
      bloom.add(log[0])
      // add the topics
      var topics = log[1]
      for (var q = 0; q < topics.length; q++) {
        bloom.add(topics[q])
      }
    }
  }
  return bloom
}
