import {
  forwardRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Input as ShadcnInput } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea as ShadcnTextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: string;
  noMargin?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, noMargin, className, id, ...props }, ref) => {
    const el = <ShadcnInput ref={ref} id={id} className={className} {...props} />;

    if (!label) return el;

    return (
      <div className={cn('flex flex-col gap-2', !noMargin && 'mb-5')}>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        {el}
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
    );
  },
);

Input.displayName = 'Input';

function parseInteger(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function finiteBound(value: number | string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatInteger(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  return parseInteger(raw) === null ? '' : raw;
}

function integerFallback(
  value: number | string | null | undefined,
  minValue: number | string | undefined,
  maxValue: number | string | undefined,
): number {
  const min = finiteBound(minValue);
  const max = finiteBound(maxValue);

  if (min !== null && max !== null) {
    const lower = Math.ceil(Math.min(min, max));
    const upper = Math.floor(Math.max(min, max));
    if (lower <= upper) {
      return lower + Math.floor(Math.random() * (upper - lower + 1));
    }
  }

  const previous = formatInteger(value);
  const parsedPrevious = parseInteger(previous);
  if (
    parsedPrevious !== null &&
    (min === null || parsedPrevious >= min) &&
    (max === null || parsedPrevious <= max)
  ) {
    return parsedPrevious;
  }

  if (min !== null) return Math.ceil(min);
  if (max !== null) return Math.floor(max);
  return 0;
}

export interface IntegerInputProps
  extends Omit<InputProps, 'type' | 'value' | 'defaultValue' | 'onChange'> {
  value: number | string | null | undefined;
  onValueChange: (value: number) => void;
  onValidityChange?: (isInteger: boolean) => void;
}

/**
 * A controlled integer input with a local editing draft. Keeping the draft as
 * text lets users temporarily clear the field (or type a leading minus sign)
 * without the parent immediately restoring the previous numeric value.
 */
export const IntegerInput = forwardRef<HTMLInputElement, IntegerInputProps>(
  (
    {
      value,
      onValueChange,
      onValidityChange,
      min,
      max,
      step = 1,
      onFocus,
      onBlur,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const [draft, setDraft] = useState(() => formatInteger(value));
    const focused = useRef(false);

    useEffect(() => {
      if (focused.current) return;
      const nextDraft = formatInteger(value);
      setDraft(nextDraft);
      onValidityChange?.(parseInteger(nextDraft) !== null);
    }, [value, onValidityChange]);

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      const minNumber = finiteBound(min);
      const disallowed = ['.', ',', 'e', 'E', '+'].includes(event.key);
      const disallowedMinus = event.key === '-' && minNumber !== null && minNumber >= 0;
      if (disallowed || disallowedMinus) event.preventDefault();
      onKeyDown?.(event);
    }

    return (
      <Input
        {...props}
        ref={ref}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        onFocus={(event) => {
          focused.current = true;
          onFocus?.(event);
        }}
        onChange={(event) => {
          const nextDraft = event.target.value;
          const parsed = parseInteger(nextDraft);
          setDraft(nextDraft);
          onValidityChange?.(parsed !== null);
          if (parsed !== null) onValueChange(parsed);
        }}
        onBlur={(event) => {
          focused.current = false;
          const parsed = parseInteger(event.currentTarget.value);
          const nextValue = parsed ?? integerFallback(value, min, max);
          setDraft(String(nextValue));
          onValueChange(nextValue);
          onValidityChange?.(true);
          onBlur?.(event);
        }}
        onKeyDown={handleKeyDown}
      />
    );
  },
);

IntegerInput.displayName = 'IntegerInput';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: string;
  noMargin?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, hint, noMargin, className, id, ...props }, ref) => {
    const el = <ShadcnTextarea ref={ref} id={id} className={className} {...props} />;

    if (!label) return el;

    return (
      <div className={cn('flex flex-col gap-2', !noMargin && 'mb-5')}>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        {el}
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
    );
  },
);

Textarea.displayName = 'Textarea';
