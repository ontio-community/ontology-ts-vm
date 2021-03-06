/*
 * Copyright (C) 2018 Matus Zamborsky & The ontology Authors
 * This file is part of The ontology library.
 *
 * The ontology is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * The ontology is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with The ontology.  If not, see <http://www.gnu.org/licenses/>.
 */
import { TracedError } from '../common/error';
import { computeMerkleRoot } from '../common/merkleTree';
import { Uint256 } from '../common/uint256';
import { Interop } from '../vm/interfaces/interop';
import { Reader } from '../vm/utils/reader';
import { Writer } from '../vm/utils/writer';
import { Header } from './header';
import { Transaction } from './transaction';

export interface BlockOptions {
  header?: Header;
  transactions?: Transaction[];
}

export class Block implements Interop {
  private header: Header;
  private transactions: Transaction[];

  constructor({ header = new Header(), transactions = [] }: BlockOptions) {
    this.header = header;
    this.transactions = transactions;
  }

  getHeader() {
    return this.header;
  }

  getHash() {
    return this.header.getHash();
  }
  getTransactions() {
    return this.transactions;
  }

  serialize(w: Writer) {
    this.header.serialize(w);

    try {
      w.writeUint32(this.transactions.length);
    } catch (e) {
      throw new TracedError('Block item Transactions length serialization failed.', e);
    }

    for (const transaction of this.transactions) {
      transaction.serialize(w);
    }
  }

  deserialize(r: Reader) {
    this.header = new Header();
    this.header.deserialize(r);

    const length = r.readUInt32();

    const hashes: Uint256[] = [];

    for (let i = 0; i < length; i++) {
      const transaction = new Transaction();

      transaction.deserialize(r);
      const txhash = transaction.getHash();
      hashes.push(txhash);
      this.transactions.push(transaction);
    }

    this.header.setTransactionsRoot(computeMerkleRoot(hashes));
  }
  toArray(): Buffer {
    const bf = new Writer();
    this.serialize(bf);
    return new Buffer(bf.getBytes());
  }
}

export function isBlock(item: Interop): item is Block {
  return item instanceof Block;
}
