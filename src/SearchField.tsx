import { forwardRef, useRef, type ComponentPropsWithoutRef } from "react";
import { Search, X } from "lucide-react";
import "./search-field.css";

type SearchFieldProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "type" | "value" | "onChange" | "className"
> & {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  iconSize?: number;
  clearLabel?: string;
};

const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      value,
      onValueChange,
      className = "",
      iconSize = 16,
      clearLabel = "Clear search",
      disabled,
      ...inputProps
    },
    ref,
  ) {
    const input = useRef<HTMLInputElement | null>(null);
    return (
      <div className={`search-field ${className}`}>
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
