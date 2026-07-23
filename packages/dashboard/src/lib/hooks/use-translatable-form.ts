import { TranslatableFormGroupContext } from '@/vdb/components/shared/translatable-form-context.js';
import { useCallback, useContext, useMemo } from 'react';

/**
 * @description
 * The public state exposed by the nearest translatable form group.
 *
 * @docsCategory hooks
 * @docsPage useTranslatableForm
 * @since 3.8.0
 */
export interface TranslatableFormState {
    /**
     * @description
     * The language currently selected for editing in the nearest translatable form group.
     */
    languageCode: string;
    /**
     * @description
     * Selects the language to edit. Languages which are not available in the active channel are ignored.
     */
    setLanguageCode: (languageCode: string) => void;
}

/**
 * @description
 * Provides access to the locally selected language in the nearest translatable form group.
 *
 * This is useful for custom form components and translation actions which need to know which translation
 * is currently being edited. It returns `undefined` outside a translatable form group, allowing the same
 * component to be used for both localized and non-localized fields.
 *
 * @example
 * ```tsx
 * const translatableForm = useTranslatableForm();
 * const languageCode = translatableForm?.languageCode;
 * ```
 *
 * @docsCategory hooks
 * @docsPage useTranslatableForm
 * @docsWeight 0
 * @since 3.8.0
 */
export function useTranslatableForm(): TranslatableFormState | undefined {
    const group = useContext(TranslatableFormGroupContext);
    const setLanguageCode = useCallback(
        (languageCode: string) => {
            if (group?.languages.includes(languageCode)) {
                group.setLanguageCode(languageCode);
            }
        },
        [group],
    );

    return useMemo(
        () =>
            group
                ? {
                      languageCode: group.languageCode,
                      setLanguageCode,
                  }
                : undefined,
        [group, setLanguageCode],
    );
}
