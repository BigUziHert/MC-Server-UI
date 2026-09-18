import { ChevronLeft, ChevronRight } from "lucide-react";
export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizes = [10, 25, 50, 100],
  label = "results",
  disabled = false,
  ariaLabels,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizes?: number[];
  label?: string;
  disabled?: boolean;
  ariaLabels?: {
    pageSize: string;
    page: string;
    previous: string;
    next: string;
  };
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pages, Math.max(1, page));
  return (
    <footer className="pagination" aria-label={`${label} pagination`}>
      <span>
        {total
          ? `${(current - 1) * pageSize + 1}–${Math.min(current * pageSize, total)} of ${total}`
          : "0"}{" "}
        {label}
      </span>
      <div>
        {onPageSizeChange && (
          <label>
            Rows{" "}
            <select
              aria-label={ariaLabels?.pageSize ?? `${label} rows per page`}
              value={pageSize}
              disabled={disabled}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="btn icon"
          aria-label={ariaLabels?.previous ?? `Previous ${label} page`}
          disabled={disabled || current <= 1}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span role="status" aria-label={ariaLabels?.page ?? `${label} page`}>
          Page {current} of {pages}
        </span>
        <button
          type="button"
          className="btn icon"
          aria-label={ariaLabels?.next ?? `Next ${label} page`}
          disabled={disabled || current >= pages}
          onClick={() => onPageChange(current + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </footer>
  );
}
