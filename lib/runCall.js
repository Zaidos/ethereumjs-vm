const async = require('async')
const ethUtil = require('ethereumjs-util')
const BN = ethUtil.BN
const fees = require('ethereum-common')
const Account = require('ethereumjs-account')

/**
 * runs a CALL operation
 * @method runCall
 * @param opts
 * @param opts.account {Account}
 * @param opts.block {Block}
 * @param opts.caller {Buffer}
 * @param opts.code {Buffer} this is for CALLCODE where the code to load is different than the code from the to account.
 * @param opts.data {Buffer}
 * @param opts.gasLimit {Bignum}
 * @param opts.gasPrice {Bignum}
 * @param opts.origin {Buffer} []
 * @param opts.to {Buffer}
 * @param opts.value {Bignum}
 */
module.exports = function(opts, cb) {
  var self = this

  var vmResults = {}
  var toAccount
  var toAddress = opts.to
  var createdAddress
  var txValue = opts.value || new BN(0)
  var account = opts.account
  var block = opts.block
  var caller = opts.caller
  var code = opts.code
  var txData = opts.data
  var gasLimit = opts.gasLimit
  var gasPrice = opts.gasPrice
  var gasUsed = new BN(0)
  var origin = opts.origin
  var isCompiled = opts.compiled
  var depth = opts.depth
  var suicides = opts.suicides

  // run and parse
  async.series([
    calculateFromAccountBalance,
    loadToAccount,
    calculateToAccountBalance,
    loadCode,
    runCode,
    saveCode,
  ], parseCallResult)


  function calculateFromAccountBalance(cb){
    var newBalance = new Buffer((new BN(account.balance).sub(txValue)).toArray())
    account.balance = newBalance
    self.stateManager.putAccountBalance(caller, account, newBalance, cb)
  }

  function loadToAccount(cb){
    // get receiver's account
    if (!toAddress) {
      // generate a new contract if no `to`
      code = txData
      txData = undefined
      createdAddress = toAddress = ethUtil.generateAddress(caller, account.nonce)
      toAccount = new Account()
      cb()
    } else {
      // else load the `to` account
      self.stateManager.getAccount(toAddress, function(err, account){
        if (err) return cb(err)
        toAccount = account
        cb()
      })
    }
  }

  function calculateToAccountBalance(cb){
    // add the amount sent to the `to` account
    var newBalance = new Buffer(new BN(toAccount.balance).add(txValue).toArray())
    toAccount.balance = newBalance
    self.stateManager.putAccountBalance(toAddress, toAccount, newBalance, cb)
  }

  function loadCode(cb) {
    // loads the contract's code if the account is a contract
    if (code || !toAccount.isContract(toAddress)) {
      cb()
      return
    }
    
    if (toAccount.isPrecompiled(toAddress)){
      isCompiled = true
      code = self._precomiled[toAddress.toString('hex')]
      return cb()
    }

    toAccount.getCode(self.trie, function(err, c, comp) {
      isCompiled = comp
      code = c
      cb(err)
    })
  }

  function runCode(cb) {
    self.cache.checkpoint()
    self.trie.checkpoint()

    if (!code) {
      self.cache.commit()
      cb()
      return
    }

    var runCodeOpts = {
      code: code,
      data: txData,
      gasLimit: gasLimit,
      gasPrice: gasPrice,
      account: toAccount,
      address: toAddress,
      origin: origin,
      caller: caller,
      value: txValue,
      block: block,
      depth: depth,
      suicides: suicides,
    }

    // run Code through vm
    var codeRunner = isCompiled ? self.runJIT : self.runCode
    codeRunner.call(self, runCodeOpts, parseRunResult)

    function parseRunResult(err, results) {
      toAccount = results.account
      vmResults = results

      if (createdAddress) {
        // dont save newly created accounts that have no balance
        if(results.exceptionError && toAccount.balance.toString('hex') === '00') {
          self.cache.del(createdAddress)
        }

        var returnFee = results.gasUsed.add(new BN(results.return.length * fees.createDataGas.v))
        if (returnFee.cmp(gasLimit) <= 0) {
          results.gasUsed = returnFee
        } else {
          results.return = new Buffer([])
        }
      }

      gasUsed = results.gasUsed

      if (results.exceptionError) {
        account.balance = new Buffer((new BN(account.balance).add(txValue)).toArray())
        self.cache.revert()
        self.cache.put(caller, account)
        self.trie.revert(cb)
      } else {
        self.cache.commit()
        self.trie.commit(cb)
      }
    }
  }

  function saveCode(cb) {
    // store code for a new contract
    if (!vmResults.exceptionError && createdAddress && vmResults.return.toString() !== ''){
      toAccount.setCode(self.trie, vmResults.return, cb)
    } else {
      cb()
    }
  }

  function parseCallResult(err) {
    // save the to account
    if (!vmResults.exceptionError) {
      self.cache.put(toAddress, toAccount)
    }

    var results = {
      gasUsed: gasUsed,
      fromAccount: account,
      toAccount: toAccount,
      createdAddress: createdAddress,
      vm: vmResults,
    }

    // this is confusing but correct
    if (results.vm.exception === undefined) {
      results.vm.exception = 1      
    }

    cb(err, results)
  }

}
