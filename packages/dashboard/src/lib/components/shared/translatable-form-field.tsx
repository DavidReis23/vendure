import { OverriddenFormComponent } from '@/vdb/framework/form-engine/overridden-form-component.js';
import { LocationWrapper } from '@/vdb/framework/layout-engine/location-wrapper.js';
import { useChannel } from '@/vdb/hooks/use-channel.js';
import { useLocalFormat } from '@/vdb/hooks/use-local-format.js';
import { useUserSettings } from '@/vdb/hooks/use-user-settings.js';
import { getLocaleFallbackPlaceholder } from '@/vdb/utils/get-locale-fallback-placeholder.js';
import { Trans, useLingui } from '@lingui/react/macro';
import { CircleAlert } from 'lucide-react';
import React, { useEffect, useMemo } from 'react';
import { Controller, ControllerProps, FieldPath, FieldValues, useFormContext } from 'react-hook-form';
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs.js';
import { applyControlProps } from './apply-control-props.js';
import { FormFieldWrapper } from './form-field-wrapper.js';
import { TranslatableFormGroupContext, useResolvedContentLanguage } from './translatable-form-context.js';

function getValueAtPath(value: unknown, path: string): unknown {
    return path.split('.').reduce<any>((current, segment) => current?.[segment], value);
}

/**
 * @description
 * Groups translatable form fields under a local language selector. Switching the selected language only
 * changes which entry in the form's `translations` array is edited; it does not change the Dashboard's
 * global content language.
 *
 * @docsCategory form-components
 * @docsPage TranslatableFormFieldWrapper
 * @since 3.8.0
 */
export function TranslatableFormGroup({
    children,
    className,
}: Readonly<{ children: React.ReactNode; className?: string }>) {
    const { activeChannel } = useChannel();
    const { formatLanguageName } = useLocalFormat();
    const { t } = useLingui();
    const { contentLanguage } = useUserSettings().settings;
    const {
        formState: { errors, submitCount },
        watch,
    } = useFormContext();
    const translations = watch('translations') as Array<{ languageCode?: string }> | undefined;
    const languages = useMemo(
        () => activeChannel?.availableLanguageCodes ?? [],
        [activeChannel?.availableLanguageCodes],
    );
    const getInitialLanguage = () =>
        languages.includes(contentLanguage as any)
            ? contentLanguage
            : (activeChannel?.defaultLanguageCode ?? languages[0] ?? contentLanguage);
    const [languageCode, setLanguageCode] = React.useState(getInitialLanguage);
    const [registeredFields, setRegisteredFields] = React.useState<string[]>([]);
    const previousSubmitCount = React.useRef(submitCount);

    const registerField = React.useCallback((fieldName: string) => {
        setRegisteredFields(current => (current.includes(fieldName) ? current : [...current, fieldName]));
        return () => setRegisteredFields(current => current.filter(name => name !== fieldName));
    }, []);

    const languagesWithErrors = useMemo(
        () =>
            languages.filter(code => {
                const translationIndex =
                    translations?.findIndex(translation => translation?.languageCode === code) ?? -1;
                if (translationIndex < 0) {
                    return false;
                }
                const translationErrors = (errors as any)?.translations?.[translationIndex];
                return registeredFields.some(
                    fieldName => getValueAtPath(translationErrors, fieldName) != null,
                );
            }),
        [errors, languages, registeredFields, translations],
    );

    useEffect(() => {
        if (!languages.includes(languageCode as any)) {
            setLanguageCode(activeChannel?.defaultLanguageCode ?? languages[0] ?? contentLanguage);
        }
    }, [activeChannel?.defaultLanguageCode, contentLanguage, languageCode, languages]);

    useEffect(() => {
        if (submitCount > previousSubmitCount.current && languagesWithErrors.length > 0) {
            setLanguageCode(languagesWithErrors[0]);
        }
        previousSubmitCount.current = submitCount;
    }, [languagesWithErrors, submitCount]);

    const content = (
        <TranslatableFormGroupContext.Provider value={{ languageCode, registerField }}>
            {children}
        </TranslatableFormGroupContext.Provider>
    );

    if (languages.length <= 1) {
        return <div className={className}>{content}</div>;
    }

    if (languages.length > 3) {
        const languageItems = Object.fromEntries(
            languages.map(code => [code, `${code.toUpperCase()} — ${formatLanguageName(code)}`]),
        );
        const currentLanguageHasErrors = languagesWithErrors.includes(languageCode as any);
        return (
            <div className="flex flex-col gap-2">
                <Select
                    items={languageItems}
                    value={languageCode}
                    onValueChange={value => value != null && setLanguageCode(String(value))}
                >
                    <SelectTrigger
                        aria-label={
                            currentLanguageHasErrors
                                ? t`Content language, has validation errors`
                                : t`Content language`
                        }
                        className="w-[220px] max-w-full"
                    >
                        <SelectValue />
                        {currentLanguageHasErrors && (
                            <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
                        )}
                    </SelectTrigger>
                    <SelectContent>
                        {languages.map(code => {
                            const hasErrors = languagesWithErrors.includes(code);
                            return (
                                <SelectItem key={code} value={code}>
                                    {languageItems[code]}
                                    {hasErrors && (
                                        <>
                                            <CircleAlert
                                                className="ms-auto size-4 text-destructive"
                                                aria-hidden="true"
                                            />
                                            <span className="sr-only">
                                                <Trans>Has validation errors</Trans>
                                            </span>
                                        </>
                                    )}
                                </SelectItem>
                            );
                        })}
                    </SelectContent>
                </Select>
                <div className={className}>{content}</div>
            </div>
        );
    }

    return (
        <Tabs value={languageCode} onValueChange={value => value != null && setLanguageCode(String(value))}>
            <TabsList className="max-w-full justify-start">
                {languages.map(code => (
                    <TabsTrigger
                        key={code}
                        value={code}
                        aria-label={
                            languagesWithErrors.includes(code)
                                ? t`${formatLanguageName(code)}, has validation errors`
                                : formatLanguageName(code)
                        }
                        title={formatLanguageName(code)}
                        data-invalid={languagesWithErrors.includes(code) || undefined}
                    >
                        {code.toUpperCase()}
                        {languagesWithErrors.includes(code) && (
                            <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
                        )}
                    </TabsTrigger>
                ))}
            </TabsList>
            <div className={className}>{content}</div>
        </Tabs>
    );
}

export type TranslatableEntity = FieldValues & {
    translations?: Array<{ languageCode: string }> | null;
};

/**
 * @description
 * The props for the TranslatableFormField component.
 *
 * @docsCategory form-components
 * @docsPage TranslatableFormFieldWrapper
 * @since 3.4.0
 */
export type TranslatableFormFieldProps<TFieldValues extends TranslatableEntity | TranslatableEntity[]> = Omit<
    ControllerProps<TFieldValues>,
    'name'
> & {
    /**
     * @description
     * The label for the form field.
     */
    label?: React.ReactNode;
    /**
     * @description
     * The name of the form field.
     */
    name: TFieldValues extends TranslatableEntity
        ? keyof Omit<NonNullable<TFieldValues['translations']>[number], 'languageCode'>
        : TFieldValues extends TranslatableEntity[]
          ? keyof Omit<NonNullable<TFieldValues[number]['translations']>[number], 'languageCode'>
          : never;
};

export const TranslatableFormField = <
    TFieldValues extends TranslatableEntity | TranslatableEntity[] = TranslatableEntity,
>({
    name,
    label,
    ...props
}: TranslatableFormFieldProps<TFieldValues>) => {
    const { formatLanguageName } = useLocalFormat();
    const contentLanguage = useResolvedContentLanguage();
    const group = React.useContext(TranslatableFormGroupContext);
    const { watch } = useFormContext();

    useEffect(() => {
        if (group) {
            return group.registerField(String(name));
        }
    }, [group?.registerField, name]);
    const formValues = watch();
    const translations = Array.isArray(formValues) ? formValues?.[0]?.translations : formValues?.translations;
    const existingIndex = translations?.findIndex(
        (translation: any) => translation?.languageCode === contentLanguage,
    );
    const isNewTranslation = existingIndex === -1;
    const index = isNewTranslation ? translations?.length : existingIndex;
    if (index === undefined || index === -1) {
        return (
            <Field>
                {label && <FieldLabel>{label}</FieldLabel>}
                <div className="text-sm text-muted-foreground">
                    <Trans>No translation found for {formatLanguageName(contentLanguage)}</Trans>
                </div>
            </Field>
        );
    }
    const translationName = `translations.${index}.${String(name)}` as FieldPath<TFieldValues>;
    return (
        <TranslatableFieldController
            {...props}
            name={translationName}
            index={index}
            isNewTranslation={isNewTranslation}
            contentLanguage={contentLanguage}
        />
    );
};

const TranslatableFieldController = <TFieldValues extends TranslatableEntity | TranslatableEntity[]>({
    index,
    isNewTranslation,
    contentLanguage,
    ...props
}: Omit<ControllerProps<TFieldValues>, 'name'> & {
    name: FieldPath<TFieldValues>;
    index: number;
    isNewTranslation: boolean;
    contentLanguage: string;
}) => {
    const { setValue, getValues } = useFormContext();

    useEffect(() => {
        if (isNewTranslation) {
            const translations = getValues('translations') || [];
            const currentLangCode = translations[index]?.languageCode;
            if (currentLangCode !== contentLanguage) {
                setValue(`translations.${index}.languageCode`, contentLanguage, { shouldDirty: true });
            }
        }
    }, [isNewTranslation, index, contentLanguage, setValue, getValues]);

    return <Controller key={`${props.name}-${contentLanguage}`} {...props} />;
};

export type TranslatableFormFieldWrapperProps<
    TFieldValues extends TranslatableEntity | TranslatableEntity[],
> = TranslatableFormFieldProps<TFieldValues> &
    Omit<React.ComponentProps<typeof FormFieldWrapper<TFieldValues>>, 'name'>;

/**
 * @description
 * This is the equivalent of the {@link FormFieldWrapper} component, but for translatable fields.
 *
 * @example
 * ```tsx
 * <TranslatableFormGroup>
 * <PageBlock column="main" blockId="main-form">
 *     <DetailFormGrid>
 *         <TranslatableFormFieldWrapper
 *             control={form.control}
 *             name="name"
 *             label={<Trans>Product name</Trans>}
 *             render={({ field }) => <Input {...field} />}
 *         />
 *         <TranslatableFormFieldWrapper
 *             control={form.control}
 *             name="slug"
 *             label={<Trans>Slug</Trans>}
 *             render={({ field }) => <Input {...field} />}
 *         />
 *     </DetailFormGrid>

 *     <TranslatableFormFieldWrapper
 *         control={form.control}
 *         name="description"
 *         label={<Trans>Description</Trans>}
 *         render={({ field }) => <RichTextInput {...field} />}
 *     />
 * </PageBlock>
 * </TranslatableFormGroup>
 * ```
 *
 * @docsCategory form-components
 * @docsPage TranslatableFormFieldWrapper
 * @docsWeight 0
 * @since 3.4.0
 */
export const TranslatableFormFieldWrapper = <
    TFieldValues extends TranslatableEntity | TranslatableEntity[] = TranslatableEntity,
>({
    label,
    description,
    renderFormControl = true,
    ...controllerProps
}: TranslatableFormFieldWrapperProps<TFieldValues>) => {
    const { name, render, ...rest } = controllerProps;
    const { activeChannel } = useChannel();
    const contentLanguage = useResolvedContentLanguage();
    const { watch } = useFormContext();
    const translations = watch('translations');
    const defaultLanguageCode = activeChannel?.defaultLanguageCode;

    const fallbackPlaceholder = useMemo(
        () => getLocaleFallbackPlaceholder(translations, defaultLanguageCode, contentLanguage, String(name)),
        [translations, defaultLanguageCode, contentLanguage, name],
    );

    return (
        <LocationWrapper identifier={name as string}>
            <TranslatableFormField
                {...rest}
                name={name}
                label={label}
                render={renderArgs => {
                    const { fieldState } = renderArgs;
                    const fieldId = `field-${String(name)}`;
                    const controlProps: Record<string, unknown> = {
                        id: fieldId,
                        'aria-invalid': fieldState.invalid || undefined,
                    };
                    if (fallbackPlaceholder) {
                        controlProps.placeholder = fallbackPlaceholder;
                    }
                    return (
                        <Field data-invalid={fieldState.invalid || undefined}>
                            {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
                            <OverriddenFormComponent field={renderArgs.field} fieldName={name as string}>
                                {renderFormControl
                                    ? applyControlProps(render(renderArgs), controlProps)
                                    : render(renderArgs)}
                            </OverriddenFormComponent>
                            {description && <FieldDescription>{description}</FieldDescription>}
                            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                        </Field>
                    );
                }}
            />
        </LocationWrapper>
    );
};
