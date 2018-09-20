import 'babel-polyfill';
import { ScEnvironment } from '../../src/scEnvironment';
import { isIntegerType } from '../../src/vm/types/integer';
import { loadContract, opLogger } from '../utils';
import { invokeMethod } from '../utils/invokeBuilder';

describe('Arith test', () => {
  test('Add', async () => {
    const contract = loadContract('./test/avm/arith.avm');

    const env = new ScEnvironment();
    const address = env.deployContract(contract);

    const call = invokeMethod(address, 'Add', [{ type: 'Integer', value: 3 }, { type: 'Integer', value: 4 }]);
    const { result, notifications } = await env.execute(call, { inspect: opLogger });

    expect(isIntegerType(result)).toBeTruthy();
    expect(result.getBigInteger().toNumber()).toBe(7);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].states).toHaveLength(1);
    expect(notifications[0].states[0]).toBe('07');
  });
});
