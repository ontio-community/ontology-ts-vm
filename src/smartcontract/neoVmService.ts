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
import { Address } from '../common/address';
import { TracedError } from '../common/error';
import { Uint256 } from '../common/uint256';
import { LedgerStore } from '../core/ledgerStore';
import { isDeployCode } from '../core/payload/deployCode';
import { ST_CONTRACT } from '../core/state/dataEntryPrefix';
import { StateItem, StateStore } from '../core/state/stateStore';
import { Transaction } from '../core/transaction';
import { PublicKey } from '../crypto/publicKey';
import { Signature } from '../crypto/signature';
import { LogCallback, LogEventInfo, NotificationCallback, NotifyEventInfo } from '../event/notifyEvents';
import { MAX_BYTEARRAY_SIZE } from '../vm/consts';
import { ExecutionContext } from '../vm/executionContext';
import { evaluationStackCount, peekStackItem, popByteArray, pushData } from '../vm/func/common';
import { ExecutionEngine, FAULT } from '../vm/interfaces/engine';
import * as O from '../vm/opCode';
import { isArrayType } from '../vm/types/array';
import { StackItem } from '../vm/types/stackItem';
import { isStructType } from '../vm/types/struct';
import { MAX_STACK_SIZE, OPCODE_GAS } from './consts';
import { ContextRef, InvokeOptions, VmService } from './context';
import * as errors from './errors';
import { gasPrice } from './gasCost';
import { ServiceMap } from './serviceMap';

const BYTE_ZERO_20: Buffer = new Buffer([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

interface NeoVmServiceOptions {
  store: LedgerStore;
  stateStore: StateStore;
  contextRef: ContextRef;
  code: Buffer;
  tx: Transaction;
  time: number;
  // height: number; - unused
  randomHash: Uint256;
  engine: ExecutionEngine;
  notificationCallback?: NotificationCallback;
  logCallback?: LogCallback;
}

export class NeoVmService implements VmService {
  private store: LedgerStore;
  private stateStore: StateStore;
  private contextRef: ContextRef;

  private notifications: NotifyEventInfo[];
  private logs: LogEventInfo[];
  private code: Buffer;
  private tx: Transaction;
  private time: number;
  // private height: number; - unused

  private randomHash: Uint256;
  private engine: ExecutionEngine;

  private notificationCallback?: NotificationCallback;
  private logCallback?: LogCallback;

  constructor(options: NeoVmServiceOptions) {
    this.store = options.store;
    this.stateStore = options.stateStore;
    this.contextRef = options.contextRef;
    this.code = options.code;
    this.tx = options.tx;
    this.time = options.time;
    // this.height = options.height;
    this.randomHash = options.randomHash;
    this.engine = options.engine;
    this.notifications = [];
    this.logs = [];
    this.notificationCallback = options.notificationCallback;
    this.logCallback = options.logCallback;
  }

  getTx() {
    return this.tx;
  }

  getTime() {
    return this.time;
  }

  getEngine() {
    return this.engine;
  }

  getContextRef() {
    return this.contextRef;
  }

  getStateStore() {
    return this.stateStore;
  }

  getStore() {
    return this.store;
  }

  getNotifications() {
    return this.notifications;
  }

  getLogs() {
    return this.logs;
  }

  getRandomHash() {
    return this.randomHash;
  }

  // Invoke a smart contract
  async invoke({ inspect = () => Promise.resolve(true) }: InvokeOptions): Promise<StackItem | undefined> {
    if (this.code.length === 0) {
      throw errors.ERR_EXECUTE_CODE;
    }

    const contractAddress = Address.parseFromVmCode(this.code);

    this.contextRef.pushContext({ contractAddress, code: this.code });
    this.engine.pushContext(new ExecutionContext(this.code));

    while (true) {
      // check the execution step count
      if (!this.contextRef.checkExecStep()) {
        throw errors.VM_EXEC_STEP_EXCEED;
      }
      if (this.engine.getContexts().length === 0) {
        break;
      }
      if (this.engine.getContext().getInstructionPointer() >= this.engine.getContext().getCode().length) {
        break;
      }
      const instructionPointer = this.engine.getContext().getInstructionPointer();
      this.engine.executeCode();

      if (this.engine.getContext().getInstructionPointer() < this.engine.getContext().getCode().length) {
        if (!this.checkStackSize()) {
          throw errors.ERR_CHECK_STACK_SIZE;
        }
      }

      const opCode = this.engine.getOpCode();
      let opName = '';
      if (opCode >= O.PUSHBYTES1 && opCode <= O.PUSHBYTES75) {
        opName = `PUSHBYTES${opCode}`;

        if (!this.contextRef.checkUseGas(OPCODE_GAS)) {
          throw errors.ERR_GAS_INSUFFICIENT;
        }
      } else {
        this.engine.validateOp();

        opName = this.engine.getOpExec().name;

        const price = gasPrice(this.engine, opName);
        if (!this.contextRef.checkUseGas(price)) {
          throw errors.ERR_GAS_INSUFFICIENT;
        }
      }

      const evaluationStack = this.getEngine().getEvaluationStack();
      const altStack = this.getEngine().getAltStack();

      const inspectionResult = await inspect({
        opCode,
        opName,
        contractAddress,
        instructionPointer,
        evaluationStack,
        altStack,
        contexts: this.getEngine().getContexts()
      });
      if (!inspectionResult) {
        return;
      }

      switch (this.engine.getOpCode()) {
        case O.VERIFY:
          if (evaluationStackCount(this.engine) < 3) {
            throw new TracedError('[VERIFY] Too few input parameters ');
          }
          const pubKey = popByteArray(this.engine);
          const key = PublicKey.deserialize(pubKey);

          const sig = popByteArray(this.engine);
          const data = popByteArray(this.engine);

          const signature = Signature.deserialize(sig);
          if (!key.verify(data, signature)) {
            pushData(this.engine, false);
          } else {
            pushData(this.engine, true);
          }
          break;
        case O.SYSCALL:
          this.systemCall();
          break;
        case O.APPCALL:
          let address = this.engine
            .getContext()
            .getReader()
            .readBytes(20);
          if (address.compare(BYTE_ZERO_20) === 0) {
            if (evaluationStackCount(this.engine) < 1) {
              throw new TracedError(`[Appcall] Too few input parameters:${evaluationStackCount(this.engine)}`);
            }

            try {
              address = popByteArray(this.engine);
            } catch (e) {
              throw new TracedError(`[Appcall] pop contract address error.`, e);
            }

            if (address.length !== 20) {
              throw new TracedError(`[Appcall] pop contract address len != 20:${address}`);
            }
          }

          const code = this.getContract(address);
          const service = this.contextRef.newExecuteEngine(code);
          this.engine.getEvaluationStack().copyTo(service.getEngine().getEvaluationStack());
          const result = await service.invoke({ inspect });

          if (result !== undefined) {
            pushData(this.engine, result);
          }
          break;
        default:
          const err = this.engine.stepInto();
          if (err !== undefined) {
            throw new TracedError(`[NeoVmService] vm execute error!`, err);
          }
          if (this.engine.getState() === FAULT) {
            throw errors.VM_EXEC_FAULT;
          }
      }
    }
    this.contextRef.popContext();
    this.contextRef.pushNotifications(this.notifications);
    this.contextRef.pushLogs(this.logs);
    if (this.engine.getEvaluationStack().count() !== 0) {
      return this.engine.getEvaluationStack().peek(0);
    }
  }

  /**
   * SystemCall provide register service for smart contract to interaction with blockchain
   */
  systemCall() {
    const serviceName = this.engine
      .getContext()
      .getReader()
      .readVarString(MAX_BYTEARRAY_SIZE);
    const service = ServiceMap.get(serviceName);
    if (service === undefined) {
      throw new TracedError(`[SystemCall] service not support: ${serviceName}`);
    }
    const price = gasPrice(this.engine, serviceName);

    if (!this.contextRef.checkUseGas(price)) {
      throw errors.ERR_GAS_INSUFFICIENT;
    }
    if (service.validator !== undefined) {
      try {
        service.validator(this.engine);
      } catch (e) {
        throw new TracedError(`[SystemCall] service validator error.`, e);
      }
    }

    try {
      service.execute(this, this.engine);
    } catch (e) {
      throw new TracedError(`[SystemCall] service execute error.`, e);
    }
  }

  /**
   * DUMMY: this method will call other SC.
   * Need to devise a way how to use it in test VM
   * @param address
   */
  getContract(address: Buffer): Buffer {
    let item: StateItem | undefined;
    try {
      item = this.stateStore.get(ST_CONTRACT, address);
    } catch (e) {
      throw new TracedError('[getContract] Get contract context error!', e);
    }

    // log.Debugf("invoke contract address:%x", scommon.ToArrayReverse(address))
    if (item === undefined) {
      throw errors.CONTRACT_NOT_EXIST;
    }
    const contract = item.value;

    if (!isDeployCode(contract)) {
      throw errors.DEPLOYCODE_TYPE_ERROR;
    }

    return contract.getCode();
  }

  checkStackSize(): boolean {
    let size = 0;
    const opCode = this.engine.getOpCode();

    if (opCode < O.PUSH16) {
      size = 1;
    } else {
      switch (opCode) {
        case O.DEPTH:
        case O.DUP:
        case O.OVER:
        case O.TUCK:
          size = 1;
          break;
        case O.UNPACK:
          if (this.engine.getEvaluationStack().count() === 0) {
            return false;
          }
          const item = peekStackItem(this.engine);
          if (isArrayType(item)) {
            size = item.count();
          } else if (isStructType(item)) {
            size = item.count();
          }
      }
    }
    size += this.engine.getEvaluationStack().count() + this.engine.getAltStack().count();
    if (size > MAX_STACK_SIZE) {
      return false;
    }
    return true;
  }

  addNotification(event: NotifyEventInfo) {
    this.notifications.push(event);

    if (this.notificationCallback !== undefined) {
      this.notificationCallback(event);
    }
  }

  addLog(event: LogEventInfo) {
    this.logs.push(event);

    if (this.logCallback !== undefined) {
      this.logCallback(event);
    }
  }

  getNotificationCallback() {
    return this.notificationCallback;
  }
}
