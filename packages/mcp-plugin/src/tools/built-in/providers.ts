import type { Provider } from '@nestjs/common';

import { shopToolProviders } from './shop';

export const mcpBuiltInToolProviders: Provider[] = [...shopToolProviders];
