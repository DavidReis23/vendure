import { IllegalOperationError } from '../../../common/error/errors';
import {
    OnTransitionEndFn,
    OnTransitionErrorFn,
    OnTransitionStartFn,
    StateMachineConfig,
    Transitions,
} from '../../../common/finite-state-machine/types';
import { validateTransitionDefinition } from '../../../common/finite-state-machine/validate-transition-definition';
import { awaitPromiseOrObservable } from '../../../common/utils';
import { Logger } from '../../../config/logger/vendure-logger';

interface StateMachineProcess<State extends string, Data> {
    onTransitionStart?: OnTransitionStartFn<State, Data>;
    onTransitionEnd?: OnTransitionEndFn<State, Data>;
    onTransitionError?: OnTransitionErrorFn<State>;
}

interface ProcessStateMachineConfigOptions<State extends string, Data> {
    transitions: Transitions<State>;
    initialState: State;
    processes: ReadonlyArray<StateMachineProcess<State, Data>>;
    processName: string;
    transitionError: string;
    onTransitionStartAfterProcesses?: OnTransitionStartFn<State, Data>;
}

export function createProcessStateMachineConfig<State extends string, Data>(
    options: ProcessStateMachineConfigOptions<State, Data>,
): StateMachineConfig<State, Data> {
    const {
        transitions,
        initialState,
        processes,
        processName,
        transitionError,
        onTransitionStartAfterProcesses,
    } = options;

    const validationResult = validateTransitionDefinition(transitions, initialState);

    if (!validationResult.valid && validationResult.error) {
        Logger.error(`The ${processName.toLowerCase()} process has an invalid configuration:`);
        throw new Error(validationResult.error);
    }

    if (validationResult.valid && validationResult.error) {
        Logger.warn(`${processName} process: ${validationResult.error}`);
    }

    return {
        transitions,
        onTransitionStart: async (fromState, toState, data) => {
            for (const process of processes) {
                if (typeof process.onTransitionStart === 'function') {
                    const result = await awaitPromiseOrObservable(
                        process.onTransitionStart(fromState, toState, data),
                    );

                    if (result === false || typeof result === 'string') {
                        return result;
                    }
                }
            }

            if (onTransitionStartAfterProcesses) {
                return await awaitPromiseOrObservable(
                    onTransitionStartAfterProcesses(fromState, toState, data),
                );
            }
        },
        onTransitionEnd: async (fromState, toState, data) => {
            for (const process of processes) {
                if (typeof process.onTransitionEnd === 'function') {
                    await awaitPromiseOrObservable(process.onTransitionEnd(fromState, toState, data));
                }
            }
        },
        onError: async (fromState, toState, message) => {
            for (const process of processes) {
                if (typeof process.onTransitionError === 'function') {
                    await awaitPromiseOrObservable(process.onTransitionError(fromState, toState, message));
                }
            }

            throw new IllegalOperationError(message || transitionError, {
                fromState,
                toState,
            });
        },
    };
}
