import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { Search, X } from "lucide-react";
import "./search-field.css";

type SearchFieldProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "type" | "value" | "onChange" | "className" | "size"
> & {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  iconSize?: number;
  clearLabel?: string;
  grow?: boolean;
};

export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      value,
      onValueChange,
      className = "",
      iconSize = 16,
      clearLabel = "Clear search",
      disabled,
      grow = false,
      ...inputProps
    },
    ref,
  ) {
    const input = useRef<HTMLInputElement | null>(null);
    return (
      <div
        className={`search-field ${grow ? "search-field-grow" : ""} ${className}`}
      >
        <Search size={iconSize} aria-hidden="true" />
        <div className="search-field-control">
          <input
            {...inputProps}
            ref={(node) => {
              input.current = node;
              if (typeof ref === "function") ref(node);
              else if (ref) ref.current = node;
            }}
            type="text"
            value={value}
            disabled={disabled}
            onChange={(event) => onValueChange(event.target.value)}
          />
          {value && (
            <button
              type="button"
              className="search-field-clear"
              aria-label={clearLabel}
              title={clearLabel}
              disabled={disabled}
              onClick={() => {
                onValueChange("");
                input.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    );
  },
);

export default SearchField;
