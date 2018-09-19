import 'babel-polyfill';
import { programFromPubKey } from '../../src/common/program';
import { RawSig, Transaction } from '../../src/core/transaction';
import { PublicKey } from '../../src/crypto/publicKey';
import { ScEnvironment } from '../../src/scEnvironment';
import { isIntegerType } from '../../src/vm/types/integer';
import { loadContract, opLogger, strToHex } from '../utils';

// tslint:disable:max-line-length
describe('Python domain auction test', () => {
  test('Register', async () => {
    const contract = loadContract('./test/avm/auction.avm');

    const env = new ScEnvironment();
    const address = env.deployContract(contract);

    // WIF L2uwqpzc8b3KgARF5gRBNiErFu3uQi87KJnSVt4rXZkVyjS2deEt
    // PK 02ece713405b19bb1ffb9123bd0309b28c7fc2f1e499934b5957e68e46638da8db

    // Address AW6oWNxj1fSxLfeoWmymLiDZT4tRdfgQd5 (963ed9649124717043b822c8a265056a5735269d)

    // call Register with params 963ed9649124717043b822c8a265056a5735269d and example.com
    const call = Buffer.concat([
      new Buffer('0b6578616d706c652e636f6d149d2635576a0565a2c822b8437071249164d93e9652c108726567697374657267', 'hex'),
      address
    ]);
    const tx = new Transaction();

    const publicKey = PublicKey.deserialize(
      new Buffer('02ece713405b19bb1ffb9123bd0309b28c7fc2f1e499934b5957e68e46638da8db', 'hex')
    );
    const verify = programFromPubKey(publicKey);
    tx.setSigs([new RawSig(new Buffer(''), verify)]);

    const { result, notifications } = await env.execute(call, { inspect: opLogger, tx });

    expect(isIntegerType(result)).toBeTruthy();
    expect(result.getBoolean()).toBeTruthy();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].states).toBe(strToHex('register succeed!'));
  });
});
