import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { FormProvider, Resolver, useForm, useFormContext } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Input } from '@/vdb/components/ui/input.js';
import { PageContext } from '@/vdb/framework/layout-engine/page-provider.js';
import {
    ChannelContext,
    type ChannelContext as ChannelContextValue,
} from '@/vdb/providers/channel-provider.js';
import { UserSettingsContext, type UserSettingsContextType } from '@/vdb/providers/user-settings.js';

import { TranslatableFormFieldWrapper, TranslatableFormGroup } from './translatable-form-field.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    i18n.load('en', {});
    i18n.activate('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

function TestProviders({
    children,
    languages = ['en', 'de'],
    contentLanguage = 'en',
    setContentLanguage = vi.fn(),
    resolver,
}: Readonly<{
    children: React.ReactNode;
    languages?: string[];
    contentLanguage?: string;
    setContentLanguage?: (language: string) => void;
    resolver?: Resolver<any>;
}>) {
    const form = useForm({
        defaultValues: {
            translations: [
                { id: 'translation-en', languageCode: 'en', name: 'English name' },
                { id: 'translation-de', languageCode: 'de', name: 'Deutscher Name' },
            ],
        },
        resolver,
    });
    const userSettings = {
        settings: {
            displayLanguage: 'en',
            contentLanguage,
            theme: 'system',
            displayUiExtensionPoints: false,
            mainNavExpanded: true,
            activeChannelId: 'channel-1',
            devMode: false,
            hasSeenOnboarding: false,
            tableSettings: {},
        },
        setContentLanguage,
    } as UserSettingsContextType;
    const channel = {
        isLoading: false,
        channels: [],
        activeChannel: {
            id: 'channel-1',
            code: 'default-channel',
            token: 'default-channel',
            defaultLanguageCode: 'en',
            defaultCurrencyCode: 'USD',
            pricesIncludeTax: false,
            availableLanguageCodes: languages,
            availableCurrencyCodes: ['USD'],
        },
        setActiveChannel: vi.fn(),
        refreshChannels: vi.fn(),
    } as unknown as ChannelContextValue;

    return (
        <I18nProvider i18n={i18n}>
            <UserSettingsContext.Provider value={userSettings}>
                <ChannelContext.Provider value={channel}>
                    <PageContext.Provider value={{ pageId: 'translation-test', form }}>
                        <FormProvider {...form}>{children}</FormProvider>
                    </PageContext.Provider>
                </ChannelContext.Provider>
            </UserSettingsContext.Provider>
        </I18nProvider>
    );
}

function SubmitButton() {
    const form = useFormContext();
    return (
        <button type="button" onClick={() => void form.handleSubmit(() => undefined)()}>
            Submit
        </button>
    );
}

function NameGroup() {
    return (
        <TranslatableFormGroup>
            <TranslatableFormFieldWrapper
                name="name"
                label="Name"
                render={({ field }) => <Input {...field} />}
            />
        </TranslatableFormGroup>
    );
}

function SetGermanNameErrorButton() {
    const { setError } = useFormContext();
    return (
        <button
            type="button"
            onClick={() => setError('translations.1.name', { type: 'manual', message: 'Required' })}
        >
            Set German error
        </button>
    );
}

describe('TranslatableFormGroup', () => {
    it('renders no selector for one language and tabs for three languages', () => {
        act(() => {
            root.render(
                <TestProviders languages={['en']}>
                    <NameGroup />
                </TestProviders>,
            );
        });

        expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
        expect(container.querySelector('[role="combobox"]')).toBeNull();

        act(() => {
            root.render(
                <TestProviders languages={['en', 'de', 'fr']}>
                    <NameGroup />
                </TestProviders>,
            );
        });

        expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    });

    it('switches the rendered translation without changing the global content language', () => {
        const setContentLanguage = vi.fn();
        act(() => {
            root.render(
                <TestProviders setContentLanguage={setContentLanguage}>
                    <NameGroup />
                </TestProviders>,
            );
        });

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('English name');

        const germanTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
            tab => tab.textContent === 'DE',
        ) as HTMLElement;
        act(() => germanTab.click());

        expect((container.querySelector('input') as HTMLInputElement).value).toBe('Deutscher Name');
        expect((container.querySelector('input') as HTMLInputElement).placeholder).toBe(
            'Fallback: English name',
        );
        expect(setContentLanguage).not.toHaveBeenCalled();
    });

    it('keeps separate groups on independently selected languages', () => {
        act(() => {
            root.render(
                <TestProviders>
                    <NameGroup />
                    <NameGroup />
                </TestProviders>,
            );
        });

        const germanTabs = Array.from(container.querySelectorAll('[role="tab"]')).filter(
            tab => tab.textContent === 'DE',
        ) as HTMLElement[];
        act(() => germanTabs[0].click());

        const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
        expect(inputs.map(input => input.value)).toEqual(['Deutscher Name', 'English name']);
    });

    it('falls back to the channel default when the global language is unavailable', () => {
        act(() => {
            root.render(
                <TestProviders contentLanguage="fr">
                    <NameGroup />
                </TestProviders>,
            );
        });

        expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('EN');
        expect((container.querySelector('input') as HTMLInputElement).value).toBe('English name');
    });

    it('initializes from the global language when it is available in the channel', () => {
        act(() => {
            root.render(
                <TestProviders contentLanguage="de">
                    <NameGroup />
                </TestProviders>,
            );
        });

        expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('DE');
        expect((container.querySelector('input') as HTMLInputElement).value).toBe('Deutscher Name');
    });

    it('supports arrow-key navigation between language tabs', async () => {
        act(() => {
            root.render(
                <TestProviders>
                    <NameGroup />
                </TestProviders>,
            );
        });

        const englishTab = container.querySelector('[role="tab"]') as HTMLElement;
        await act(async () => {
            englishTab.focus();
            englishTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            await Promise.resolve();
        });

        const germanTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
            tab => tab.textContent === 'DE',
        ) as HTMLElement;
        expect(document.activeElement).toBe(germanTab);
    });

    it('uses a select instead of tabs when the channel has more than three languages', () => {
        act(() => {
            root.render(
                <TestProviders languages={['en', 'de', 'fr', 'es']}>
                    <NameGroup />
                </TestProviders>,
            );
        });

        expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
        expect(container.querySelector('[role="combobox"]')).not.toBeNull();
    });

    it('marks only the language containing an error for a field in the group', () => {
        act(() => {
            root.render(
                <TestProviders>
                    <NameGroup />
                    <SetGermanNameErrorButton />
                </TestProviders>,
            );
        });

        act(() => (container.querySelector('button:not([role="tab"])') as HTMLButtonElement).click());

        const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
        expect(tabs[0].getAttribute('aria-label')).toBe('English');
        expect(tabs[1].getAttribute('aria-label')).toContain('validation errors');
        expect(tabs[1].querySelector('svg')).not.toBeNull();
    });

    it('opens the first language with a group error after an invalid submit', async () => {
        const resolver: Resolver<any> = async () => ({
            values: {},
            errors: {
                translations: [
                    {},
                    {
                        name: { type: 'required', message: 'Required' },
                    },
                ],
            },
        });
        await act(async () => {
            root.render(
                <TestProviders resolver={resolver}>
                    <NameGroup />
                    <SubmitButton />
                </TestProviders>,
            );
        });

        await act(async () => {
            (container.querySelector('button:not([role="tab"])') as HTMLButtonElement).click();
        });

        const germanTab = Array.from(container.querySelectorAll('[role="tab"]')).find(tab =>
            tab.textContent?.includes('DE'),
        );
        expect(germanTab?.getAttribute('aria-selected')).toBe('true');
        expect((container.querySelector('input') as HTMLInputElement).value).toBe('Deutscher Name');
    });
});
