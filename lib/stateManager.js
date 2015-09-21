/*

//
// BLOCKCHAIN STATE LOOKUPS
//

// block number -> hash (in BLOCKHASH)
self.blockchain.getBlockByNumber(number, function (err, block) {
  if (err) return done(err)
  stack.push(block.hash())
  done()
})

// code lookup
account.getCode(self.trie, function (err2, code, compiled) {...})

// cache read writes
self.cache.getOrLoad(address, function (err, account) {
self.cache.getOrLoad(to, function (err, account) {
self.cache.getOrLoad(suicideTo, function(err, toAccount){
self.cache.get(opts.address)
self.cache.put(suicideTo, toAccount)
self.cache.put(opts.address, opts.account)
self.cache.put(caller, account)
self.cache.get(toAddress)
self.cache.checkpoint()
self.cache.commit()
self.cache.del(createdAddress)
self.cache.revert()
self.cache.put(caller, account)
self.cache.commit()
self.cache.put(toAddress, toAccount)

primary goal of cache mechanism:
  - pre-fetch from state trie
  - materializing to accnt obj
  - hold uncommited state

// update storageTrie
opts.account = self.cache.get(opts.address)
storageTrie.root = opts.account.stateRoot

self
  cache
  trie
  blockchain
  _precomiled


??

- Account objects, do they have any recency guarantees?
should they?
are they best as snapshots of the time of serialization?

- for the cache, do we ever checkpoint at a time when we dont
checkpoint the stateTrie?
what is the purpose?
  synchronous lookups?
  serialized objects?

- when is `vm.loadCompiled` used?

- how the hell to generalize `results.vm.storageTries`??

*/
const Trie = require('merkle-patricia-tree/secure.js')
const async = require('async')
const BN = require('bn.js')
const Account = require('ethereumjs-account')
const HistoryTree = require('history-tree')
const fakeBlockchain = require('./fakeBlockChain.js')
const Cache = require('./cache.js')


module.exports = StateManager


function StateManager(opts){
  var trie = opts.trie
  if (!trie || !trie.db) {
    trie = new Trie(trie)
  }

  var blockchain = opts.blockchain
  if (!blockchain) {
    blockchain = fakeBlockchain
  }

  this.blockchain = blockchain
  this.trie = trie
  this._storageTries = {}
  this.cache = new Cache(trie)
  this.history = new HistoryTree()

  this.history.on('commit', trie.commit.bind(trie))
  this.history.on('revert', trie.revert.bind(trie))
}

var proto = StateManager.prototype

//
// account
//

proto.getAccount = function(address, cb){
  var self = this
  self.cache.getOrLoad(new Buffer(address, 'hex'), cb)
}

proto.putAccount = function(address, account, cb){
  var self = this
  var addressHex = new Buffer(address, 'hex')
  // TODO: dont save newly created accounts that have no balance
  // if (toAccount.balance.toString('hex') === '00') {
  // if they have money or a non-zero nonce or code, then write to tree
  self.cache.put(addressHex, account)
  self.trie.put(addressHex, account.serialize(), cb)
}

proto.incrementAccountNonce = function(address, cb){
  var self = this
  self.getAccount(address, function(err, account){
    if (err) return cb(err)
    account.nonce++
    self.putAccount(address, account, cb)
  })
}

proto.getAccountBalance = function(address, cb){
  var self = this
  self.getAccount(address, function(err, account){
    if (err) return cb(err)
    cb(null, account.balance)
  })
}

proto.putAccountBalance = function(address, account, balance, cb){
  var self = this
  self.getAccount(address, function(err, account){
    if (err) return cb(err)
    account.balance = balance
    self.putAccount(address, account, cb)
  })
}

// sets the contract code on the account
proto.putContractCode = function(address, account, value, cb){
  var self = this
  account.setCode(self.trie, value, function(err){
    if (err) return cb(err)
    self.putAccount(address, account, cb)
  })
}

// given an account object, returns the code
proto.getContractCode = function(account, cb){
  var self = this
  account.getCode(self.trie, cb)
}

proto.getContractCodeByAddress = function(address, cb){
  var self = this
  self.getAccount(address, function(err, account){
    if (err) return cb(err)
    self.getContractCode(account, cb)
  })
}

proto.getContractStorage = function(address, key, cb){
  var self = this
  self.getAccount(address, function(err, contract){
    if (err) return cb(err)
    contract.getStorage(self.trie, key, cb)
  })
}

proto.commitContracts = function(cb){
  var self = this
  async.each(Object.keys(self._storageTries), function (address, cb) {
    var trie = self._storageTries[address]
    delete self._storageTries[address]
    trie.commit(cb)
  }, cb)
}

proto.revertContracts = function(){
  var self = this
  self._storageTries = {}
}

// proto.putContractStorage = function(address, key, value, cb){
proto.putContractStorage = function(address, contract, key, value, cb){
  var self = this
  var checkpoint = self.history.getCurrentCheckpoint()
  // var contract = undefined

  var storageTrie = undefined
  var originalRoot = undefined

  async.series([
    loadStateTrie,
    setupRevertHandler,
    updateContract,
  ], cb)

  function loadStateTrie(cb){
    self.getAccount(address, function(err, _contract){
      var a=contract.nonce.toString('hex'); var b=_contract.nonce.toString('hex'); if (a!==b) console.log('alert -- nonce:', a, b)
      var a=contract.balance.toString('hex'); var b=_contract.balance.toString('hex'); if (a!==b) console.log('alert -- balance:', a, b)
      var a=contract.stateRoot.toString('hex'); var b=_contract.stateRoot.toString('hex'); if (a!==b) console.log('alert -- stateRoot:', a, b)
      var a=contract.codeHash.toString('hex'); var b=_contract.codeHash.toString('hex'); if (a!==b) console.log('alert -- codeHash:', a, b)
      // contract = _contract
      if (err) return cb(err)
      originalRoot = contract.stateRoot
      storageTrie = self._storageTries[address.toString('hex')]
      if (!storageTrie) {
        storageTrie = self.trie.copy()
        storageTrie._checkpoints = []
        storageTrie.root = contract.stateRoot
        self._storageTries[address.toString('hex')] = storageTrie
      }
      cb()
    })
  }

  // revert account state after set
  function setupRevertHandler(cb) {
    // if no checkpoint skip revert handler
    if (!checkpoint) return cb()
    checkpoint.on('rejected', function(cb){
      contract.stateRoot = originalRoot
      self.putAccount(address, contract, cb)
    })
    cb()
  }

  // set account code to new value
  function updateContract(cb){
    // create contract trie
    storageTrie.put(key, value, function(err) {
      if (err) return cb()
      contract.stateRoot = storageTrie.root
      self.putAccount(address, contract, cb)
    })
  }
}


//
// blockchain
//

proto.getBlockHashByNumber = function(number, cb) {
  var self = this
  self.blockchain.getBlockByNumber(number, function(err, block){
    if (err) return cb(err)
    var blockHash = block.hash()
    cb(null, blockHash)
  })
}

//
// revision history
//

proto.checkpoint = function(cb){
  var self = this
  self.trie.checkpoint(cb)
  self.history.checkpoint()
}

proto.commit = function(cb){
  var self = this
  self.history.commit(cb)
}

proto.revert = function(cb){
  var self = this
  self.history.revert(cb)
}

//
// cache stuff
//

proto.getStateRoot = function(cb){
  var self = this
  self.cacheFlush(function(err){
    if (err) return cb(err)
    var stateRoot = self.trie.root
    cb(null, stateRoot)
  })
}

proto.warmCache = function(addresses, cb){
  var self = this

  //shim till async supports iterators
  var accountArr = []
  addresses.forEach(function(val) {
    if (val) accountArr.push(val)
  })

  async.eachSeries(accountArr, function(acnt, done) {
    acnt = new Buffer(acnt, 'hex')
    self.trie.get(acnt, function(err, val) {
      val = new Account(val)
      self.cache.put(acnt, val, true)
      done()
    })
  }, cb)
}

proto.cacheGet = function(key){
  var self = this
  return self.cache.get(key)
}

proto.cachePut = function(key, value){
  var self = this
  return self.cache.put(key, value)
}

proto.cacheDel = function(key){
  var self = this
  return self.cache.del(key)
}

proto.cacheFlush = function(cb){
  var self = this
  self.cache.flush(cb)
}

proto.cacheCheckpoint = function(){
  var self = this
  self.cache.checkpoint()
}

proto.cacheCommit = function(){
  var self = this
  self.cache.commit()
}

proto.cacheRevert = function(){
  var self = this
  self.cache.revert()
}


