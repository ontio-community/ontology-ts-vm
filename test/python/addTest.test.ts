import 'babel-polyfill';
import { ScEnvironment } from '../../src/scEnvironment';
import { isIntegerType } from '../../src/vm/types/integer';
import { loadContract, opLogger } from '../utils';

describe('AddTest test', () => {
  test('AddTest', async () => {
    const contract = loadContract('./test/python/sc/addTest.avm');

    const env = new ScEnvironment();
    const address = env.deployContract(contract);

    const call = Buffer.concat([new Buffer('05576f726c6451c10548656c6c6f67', 'hex'), address]);
    const { result, notifications } = await env.execute(call, { inspect: opLogger });

    expect(isIntegerType(result)).toBeTruthy();
    expect(result.getBoolean()).toBeTruthy();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].states).toHaveLength(1);
    expect(notifications[0].states[0]).toBe(new Buffer('World').toString('hex'));
  });
});