import { Injectable } from '@nestjs/common';

import { RequestContext } from '../../../api/common/request-context';
import { FSM } from '../../../common/finite-state-machine/finite-state-machine';
import { mergeTransitionDefinitions } from '../../../common/finite-state-machine/merge-transition-definitions';
import { StateMachineConfig, Transitions } from '../../../common/finite-state-machine/types';
import { awaitPromiseOrObservable } from '../../../common/utils';
import { ConfigService } from '../../../config/config.service';
import { Order } from '../../../entity/order/order.entity';
import { Payment } from '../../../entity/payment/payment.entity';
import { createProcessStateMachineConfig } from '../state-machine/process-state-machine-config';

import { PaymentState, PaymentTransitionData } from './payment-state';

@Injectable()
export class PaymentStateMachine {
    private readonly config: StateMachineConfig<PaymentState, PaymentTransitionData>;
    private readonly initialState: PaymentState = 'Created';

    constructor(private configService: ConfigService) {
        this.config = this.initConfig();
    }

    getInitialState(): PaymentState {
        return this.initialState;
    }

    canTransition(currentState: PaymentState, newState: PaymentState): boolean {
        return new FSM(this.config, currentState).canTransitionTo(newState);
    }

    getNextStates(payment: Payment): readonly PaymentState[] {
        const fsm = new FSM(this.config, payment.state);
        return fsm.getNextStates();
    }

    async transition(ctx: RequestContext, order: Order, payment: Payment, state: PaymentState) {
        const fsm = new FSM(this.config, payment.state);
        const result = await fsm.transitionTo(state, { ctx, order, payment });
        payment.state = state;
        return result;
    }

    private initConfig(): StateMachineConfig<PaymentState, PaymentTransitionData> {
        const { paymentMethodHandlers } = this.configService.paymentOptions;
        const customProcesses = this.configService.paymentOptions.customPaymentProcess ?? [];
        const processes = [...customProcesses, ...(this.configService.paymentOptions.process ?? [])];

        const allTransitions = processes.reduce(
            (transitions, process) =>
                mergeTransitionDefinitions(transitions, process.transitions as Transitions<any>),
            {} as Transitions<PaymentState>,
        );

        return createProcessStateMachineConfig({
            transitions: allTransitions,
            initialState: this.initialState,
            processes,
            processName: 'Payment',
            transitionError: 'error.cannot-transition-payment-from-to',
            onTransitionStartAfterProcesses: async (fromState, toState, data) => {
                for (const handler of paymentMethodHandlers) {
                    if (data.payment.method === handler.code) {
                        const result = await awaitPromiseOrObservable(
                            handler.onStateTransitionStart(fromState, toState, data),
                        );

                        if (result !== true) {
                            return result;
                        }
                    }
                }
            },
        });
    }
}
