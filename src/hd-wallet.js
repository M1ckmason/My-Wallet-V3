var assert = require('assert');
var Bitcoin = require('bitcoinjs-lib');
var BIP39 = require('bip39');

var MyWallet = require('./wallet');
var WalletStore = require('./wallet-store');
var WalletCrypto = require('./wallet-crypto');

var HDAccount = require('./hd-account');


// If second_password is not null we assume double encryption is set on the
// wallet. We don't have access to the internal double_encryption variable
// here.


function HDWallet(seedHex, bip39Password, second_password) {

  if (bip39Password == undefined || bip39Password == null) {
    bip39Password = "";
  }

  assert(typeof(bip39Password) === "string", "BIP 39 password must be set or an empty string");

  this.seedHex = seedHex == null || seedHex == undefined || seedHex == "" || second_password == null ? seedHex : WalletCrypto.encryptSecretWithSecondPassword(seedHex, second_password, WalletStore.getSharedKey(), WalletStore.getPbkdf2Iterations());
  this.bip39Password = bip39Password == "" || second_password == null ? bip39Password : WalletCrypto.encryptSecretWithSecondPassword(bip39Password, second_password, WalletStore.getSharedKey(), WalletStore.getPbkdf2Iterations());

  this.numTxFetched = 0;
  this.accountArray = [];
}

HDWallet.buildHDWallet = function(seedHexString, accountsArrayPayload, bip39Password, secondPassword, success, error) {
  assert(typeof(bip39Password) === "string", "BIP 39 password must be set or an empty string");

  var hdwallet = new HDWallet(seedHexString, bip39Password, secondPassword);

  for (var i = 0; i < accountsArrayPayload.length; i++) {
    var accountPayload = accountsArrayPayload[i];
    var hdaccount;

    if (accountPayload.archived == true) {
      hdaccount = hdwallet.createArchivedAccount(accountPayload.label, accountPayload.xpriv, accountPayload.xpub);
      hdaccount.setIsArchived(true);
      hdwallet.accountArray.push(hdaccount);
    } else {
      // This is called when a wallet is loaded, not when it's initially created. 
      // If second password is enabled then accountPayload.xpriv has already been 
      // encrypted. We're keeping it in an encrypted state.

      // :base64: is used in some older dev. versions of the HD wallet and does not occur "in the wild"
      if(accountPayload.cache == undefined || accountPayload.cache.externalAccountPubKey == undefined || accountPayload.cache.externalAccountPubKey == "" || accountPayload.cache.externalAccountPubKey.slice(2,8) == "base64") {
        hdaccount = hdwallet.createAccountFromExtKey(accountPayload.label, accountPayload.xpriv, accountPayload.xpub);
        hdaccount.generateCache();
        hdwallet.accountArray.push(hdaccount);
        MyWallet.backupWalletDelayed();
      } else {
        var cache = {
          externalAccountPubKey: Bitcoin.ECPubKey.fromBuffer(Buffer(accountPayload.cache.externalAccountPubKey, "base64")),
          externalAccountChainCode: Buffer(accountPayload.cache.externalAccountChainCode, "base64"),
          internalAccountPubKey: Bitcoin.ECPubKey.fromBuffer(Buffer(accountPayload.cache.internalAccountPubKey, "base64")),
          internalAccountChainCode: Buffer(accountPayload.cache.internalAccountChainCode, "base64")
        };

        hdaccount = hdwallet.createAccountFromExtKey(accountPayload.label, accountPayload.xpriv, accountPayload.xpub, cache);
        hdaccount.cache = accountPayload.cache;
        hdwallet.accountArray.push(hdaccount);

      }
      hdaccount.setIsArchived(false);

    }

    hdaccount.address_labels = accountPayload.address_labels ? accountPayload.address_labels : [];
  }

  success && success(hdwallet);
};

// TODO integrate changes to receive/change addr count
function recoverHDWallet(hdwallet, secondPassword, successCallback, errorCallback) {
  assert(secondPassword === null || secondPassword, "Second password must be null or set.");

  var LOOK_AHEAD_ADDRESS_COUNT = 20;
  var accountIdx = 0;

  var continueLookingAheadAccount = true;

  while(continueLookingAheadAccount) {
    var account = hdwallet.createAccount("Account " + accountIdx.toString(), secondPassword);


    var lookAheadOffset = 0;
    var accountAddressIdx = -1;
    var continueLookingAheadAddress = true;
    while(continueLookingAheadAddress) {
      var addresses = [];
      var addressToIdxDict = {};

      for (var i = lookAheadOffset; i < lookAheadOffset + LOOK_AHEAD_ADDRESS_COUNT; i++) {
        var address = account.generateAddress();
        addresses.push(address);
        addressToIdxDict[address] = i;
      }

      MyWallet.get_history_with_addresses(addresses, function(obj) {
        for (var i = 0; i < obj.addresses.length; ++i) {
          if (obj.addresses[i].n_tx > 0 && addressToIdxDict[obj.addresses[i].address] > accountAddressIdx) {
            accountAddressIdx = addressToIdxDict[obj.addresses[i].address];
          }
        }

        if (accountAddressIdx < lookAheadOffset) {
          continueLookingAheadAddress = false;
        }

        lookAheadOffset += LOOK_AHEAD_ADDRESS_COUNT;
      }, function() {
        if (errorCallback)
          errorCallback();
        return;
      });
    }

    while(account.getAddressesCount() > accountAddressIdx+1) {
      account.undoGenerateAddress();
    }
    account.receiveAddressCount = account.getAddressesCount();

    lookAheadOffset = 0;
    var accountChangeAddressIdx = -1;
    var continueLookingAheadChangeAddress = true;
    while(continueLookingAheadChangeAddress) {
      var addresses = [];
      var addressToIdxDict = {};

      for (var i = lookAheadOffset; i < lookAheadOffset + LOOK_AHEAD_ADDRESS_COUNT; i++) {
        var address = account.generateChangeAddress();
        addresses.push(address);
        addressToIdxDict[address] = i;
      }

      MyWallet.get_history_with_addresses(addresses, function(obj) {
        for (var i = 0; i < obj.addresses.length; ++i) {
          if (obj.addresses[i].n_tx > 0 && addressToIdxDict[obj.addresses[i].address] > accountChangeAddressIdx) {
            accountChangeAddressIdx = addressToIdxDict[obj.addresses[i].address];
          }
        }

        if (accountChangeAddressIdx < lookAheadOffset) {
          continueLookingAheadChangeAddress = false;
        }

        lookAheadOffset += LOOK_AHEAD_ADDRESS_COUNT;
      }, function() {
        if (errorCallback)
          errorCallback();
        return;
      });
    }

    while(account.getChangeAddressesCount() > accountChangeAddressIdx+1) {
      account.undoGenerateChangeAddress();
    }
    account.changeAddressCount = account.getChangeAddressesCount();

    if (accountAddressIdx == -1 && accountChangeAddressIdx == -1) {
      continueLookingAheadAccount = false;
      hdwallet.accountArray.pop();
    } else {
      accountIdx += 1;
    }
  }

  if (hdwallet.getAccountsCount() < 1) {
    hdwallet.createAccountWithSeedhex("Account 1", hdwallet.getSeedHexString(), hdwallet.getBip39Password(), secondPassword);
  }

  successCallback && successCallback(hdwallet);
};

HDWallet.recoverHDWalletFromSeedHex = function(seedHex, bip39Password, secondPassword, successCallback, errorCallback) {
  assert(typeof(bip39Password) === "string", "BIP 39 password must be set or an empty string");

  var hdwallet = new HDWallet(seedHex, bip39Password, secondPassword);
  recoverHDWallet(hdwallet, secondPassword, successCallback, errorCallback);
};

HDWallet.recoverHDWalletFromMnemonic = function(passphrase, bip39Password, secondPassword, successCallback, errorCallback) {  
  assert(typeof(bip39Password) === "string", "BIP 39 password must be set or an empty string");

  var hdwallet = new HDWallet(BIP39.mnemonicToEntropy(passphrase), bip39Password, secondPassword);
  recoverHDWallet(hdwallet, secondPassword, successCallback, errorCallback);
};


HDWallet.prototype.getPassphraseString = function(seedHex) {
  return BIP39.entropyToMnemonic(seedHex);
};

HDWallet.prototype.setSeedHexString = function(seedHex) {
  this.seedHex = seedHex;
};

HDWallet.prototype.getSeedHexString = function(second_password) {
  if(this.seedHex == null || second_password == null) {
    return this.seedHex;
  } else {
    return WalletCrypto.decryptSecretWithSecondPassword(this.seedHex, second_password, WalletStore.getSharedKey(), WalletStore.getPbkdf2Iterations());
  }
};

HDWallet.prototype.getMasterHex = function(seedHex) {
  return BIP39.mnemonicToSeed(this.getPassphraseString(seedHex), this.bip39Password);
};

HDWallet.prototype.getBip39Password = function(second_password) {
  assert(typeof(this.bip39Password) === "string", "BIP 39 password must be set or an empty string");

  if(this.bip39Password === "" || second_password == null) {
    return this.bip39Password;
  } else {
    return WalletCrypto.decryptSecretWithSecondPassword(this.bip39Password, second_password, WalletStore.getSharedKey(), WalletStore.getPbkdf2Iterations());
  }
};

HDWallet.prototype.setBip39Password = function(bip39Password) {
  this.bip39Password = bip39Password;
};

HDWallet.prototype.getAccountsCount = function() {
  return this.accountArray.length;
};

HDWallet.prototype.getAccount = function(accountIdx) {
  var account = this.accountArray[accountIdx];
  return account;
};

HDWallet.prototype.replaceAccount = function(accountIdx, account) {
  this.accountArray[accountIdx] = account;
};

HDWallet.prototype.filterTransactionsForAccount = function(accountIdx, transactions, paidTo, tx_notes) {
  var account = this.accountArray[accountIdx];

  var idx = accountIdx;

  var filteredTransactions = [];
  var rawTxs = transactions.filter(function(element) {
    return element.account_indexes.indexOf(idx) != -1;
  });

  for (var i in rawTxs) {
    var tx = rawTxs[i];
    var transaction = {};

    // Default values:
    transaction.to_account= null;
    transaction.from_account = null;
    transaction.from_addresses = [];
    transaction.to_addresses = [];
    transaction.amount = 0;

    var isOrigin = false;
    for (var i = 0; i < tx.inputs.length; ++i) {
      var output = tx.inputs[i].prev_out;
      if (!output || !output.addr)
        continue;

      if (output.xpub != null && account.getAccountExtendedKey(false) == output.xpub.m) {
        isOrigin = true;
        transaction.amount -= output.value;
      } else {
        transaction.from_addresses.push(output.addr);
      }
    }

    transaction.intraWallet = false;
    for (var i = 0; i < tx.out.length; ++i) {
      var output = tx.out[i];
      if (!output || !output.addr)
        continue;
      if (output.xpub != null && account.getAccountExtendedKey(false) == output.xpub.m) {
        transaction.amount += output.value;
      } else {
        transaction.to_addresses.push(output.addr);
        if (!isOrigin) {
          for (var j in this.getAccounts()) {
            var otherAccount = this.getAccount(j);
            if (otherAccount.getAccountExtendedKey(false) == output.xpub.m) {
              transaction.intraWallet = true;
              break;
            }
          }
        }
      }
    }

    transaction.hash = tx.hash;
    transaction.confirmations = MyWallet.getConfirmationsForTx(WalletStore.getLatestBlock(), tx);

    if(isOrigin) {
      transaction.from_account = idx;
    } else {
      transaction.to_account = idx;
    }

    transaction.note = tx_notes[tx.hash] ? tx_notes[tx.hash] : null;

    if (tx.time > 0) {
      transaction.txTime = new Date(tx.time * 1000);
    }

    if (paidTo[transaction.hash] != null) {
      transaction.paidTo = paidTo[transaction.hash];
    }

    filteredTransactions.push(transaction);
  }

  return filteredTransactions;
};

HDWallet.prototype.getAccounts = function() {
  return this.accountArray;
};

HDWallet.prototype.createArchivedAccount = function(label, possiblyEncryptedExtendedPrivateKey, extendedPublicKey) {
  var accountIdx = this.accountArray.length;
  var account = new HDAccount(null, null, label, accountIdx);
  account.extendedPrivateKey = possiblyEncryptedExtendedPrivateKey;
  account.extendedPublicKey = extendedPublicKey;

  return account;
};

// This is called when a wallet is loaded, not when it's initially created. 
// If second password is enabled then accountPayload.xpriv has already been 
// encrypted. We're keeping it in an encrypted state.
HDWallet.prototype.createAccountFromExtKey = function(label, possiblyEncryptedExtendedPrivateKey, extendedPublicKey, cache) {
  var accountIdx = this.accountArray.length;
  var account = new HDAccount(null, null, label, accountIdx);
  account.newNodeFromExtKey(extendedPublicKey, cache);
  account.extendedPrivateKey = possiblyEncryptedExtendedPrivateKey;
  account.extendedPublicKey = extendedPublicKey;

  return account;
};

HDWallet.prototype.createAccount = function(label, second_password) {
  var seedHex = this.getSeedHexString(second_password);
  var bip39Password = this.getBip39Password(second_password);

  assert(typeof(bip39Password) === "string", "BIP 39 password must be set or an empty string");

  var account = this.createAccountWithSeedhex(label, seedHex, bip39Password, second_password);

  return account;
};

HDWallet.prototype.createAccountWithSeedhex = function(label, seedHex, bip39Password, second_password) {
  assert(typeof(bip39Password) === "string", "BIP 39 password must be set or an empty string");

  var accountIdx = this.accountArray.length;

  var account = new HDAccount(this.getMasterHex(seedHex, bip39Password), null, label, accountIdx);

  /* BIP 44 defines the following 5 levels in BIP32 path:
   * m / purpose' / coin_type' / account' / change / address_index
   * Apostrophe in the path indicates that BIP32 hardened derivation is used.
   *
   * Purpose is a constant set to 44' following the BIP43 recommendation
   * Registered coin types: 0' for Bitcoin
   */
  var accountZero = account.getMasterKey().deriveHardened(44).deriveHardened(0).deriveHardened(accountIdx);
  account.externalAccount = accountZero.derive(0);
  account.internalAccount = accountZero.derive(1);

  var extendedPrivateKey = accountZero.toBase58();
  var extendedPublicKey =  accountZero.neutered().toBase58();    

  account.extendedPrivateKey = extendedPrivateKey == null || second_password == null ? extendedPrivateKey : WalletCrypto.encryptSecretWithSecondPassword(extendedPrivateKey, second_password, WalletStore.getSharedKey(), WalletStore.getPbkdf2Iterations());    
  account.extendedPublicKey = extendedPublicKey;

  account.generateCache();

  this.accountArray.push(account);

  return account;
};

module.exports = HDWallet;
