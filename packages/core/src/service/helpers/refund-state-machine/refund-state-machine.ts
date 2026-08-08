import { Injectable } from '@nestjs/common';

import { RequestContext } from '../../../api/common/request-context';
import { FSM } from '../../../common/finite-state-machine/finite-state-machine';
import { mergeTransitionDefinitions } from '../../../common/finite-state-machine/merge-transition-definitions';
import { StateMachineConfig, Transitions } from '../../../common/finite-state-machine/types';
import { ConfigService } from '../../../config/config.service';
import { Order } from '../../../entity/order/order.entity';
import { Refund } from '../../../entity/refund/refund.entity';
import { createProcessStateMachineConfig } from '../state-machine/process-state-machine-config';

import { RefundState, RefundTransitionData } from './refund-state';

@Injectable()
export class RefundStateMachine {
    private readonly config: StateMachineConfig<RefundState, RefundTransitionData>;
    private readonly initialState: RefundState = 'Pending';

    constructor(private configService: ConfigService) {
        this.config = this.initConfig();
    }

    getInitialState(): RefundState {
        return this.initialState;
    }

    getNextStates(refund: Refund): readonly RefundState[] {
        const fsm = new FSM(this.config, refund.state);
        return fsm.getNextStates();
    }

    async transition(ctx: RequestContext, order: Order, refund: Refund, state: RefundState) {
        const fsm = new FSM(this.config, refund.state);
        const result = await fsm.transitionTo(state, { ctx, order, refund });
        refund.state = state;
        return result;
    }

    private initConfig(): StateMachineConfig<RefundState, RefundTransitionData> {
        const processes = [...(this.configService.paymentOptions.refundProcess ?? [])];

        const allTransitions = processes.reduce(
            (transitions, process) =>
                mergeTransitionDefinitions(transitions, process.transitions as Transitions<any>),
            {} as Transitions<RefundState>,
        );

        return createProcessStateMachineConfig({
            transitions: allTransitions,
            initialState: this.initialState,
            processes,
            processName: 'Refund',
            transitionError: 'error.cannot-transition-refund-from-to',
        });
    }
}
