import {
  BarChart3,
  Camera,
  FileText,
  FolderTree,
  History,
  LayoutTemplate,
  Mail,
  MessageSquareText,
  Package,
  Receipt,
  Rocket,
  Scroll,
  Settings,
  Sheet,
  ShoppingBag,
  Star,
  Store,
  Ticket,
  TrendingUp,
  Upload,
  Users,
} from "lucide-react";

/**
 * Every section of the admin, in one list.
 *
 * THIS IS THE ONLY PLACE A SECTION IS DECLARED. The tile grid, the page
 * headings and the jump-to-section links off the publish queue all read from
 * here, so adding a section is one entry plus one route file — never a layout
 * change. That was the point of moving off the tab bar: tabs meant a new
 * section had to be added to a union type, a button list and a render chain,
 * and getting two of the three right left a tab that existed but showed
 * nothing.
 *
 * `id` matches the old tab identifiers, because PublishQueue still emits them
 * when it offers to jump to the item you are about to publish.
 */
export interface AdminSection {
  id: string;
  label: string;
  href: string;
  /** One line, in the admin's terms, not the schema's. */
  blurb: string;
  icon: typeof Package;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    id: "products",
    label: "Products & Stock",
    href: "/admin/dashboard/products",
    blurb: "Add pieces, edit prices, set stock",
    icon: Package,
  },
  {
    id: "categories",
    label: "Categories",
    href: "/admin/dashboard/categories",
    blurb: "Sections, sub-categories and what's visible",
    icon: FolderTree,
  },
  {
    id: "content",
    label: "Homepage Content",
    href: "/admin/dashboard/homepage-content",
    blurb: "Hero, seasonal band and the why-us copy",
    icon: LayoutTemplate,
  },
  {
    id: "pages",
    label: "Pages",
    href: "/admin/dashboard/pages",
    blurb: "About, policies, size guide and the rest",
    icon: FileText,
  },
  {
    id: "journal",
    label: "Journal",
    href: "/admin/dashboard/journal",
    blurb: "Write and publish journal entries",
    icon: FileText,
  },
  {
    id: "activity",
    label: "Activity",
    href: "/admin/dashboard/activity",
    blurb: "Who changed what, and when",
    icon: History,
  },
  {
    id: "queue",
    label: "Review & Publish",
    href: "/admin/dashboard/review-publish",
    blurb: "Check every pending change before it goes live",
    icon: Rocket,
  },
  {
    id: "orders",
    label: "Orders",
    href: "/admin/dashboard/orders",
    blurb: "Fulfil orders and record dispatch",
    icon: ShoppingBag,
  },
  {
    id: "reviews",
    label: "Reviews",
    href: "/admin/dashboard/reviews",
    blurb: "Read, hide or remove customer reviews",
    icon: Star,
  },
  {
    id: "style",
    label: "Customer Style",
    href: "/admin/dashboard/style",
    blurb: "Approve or turn down photographs customers have sent",
    icon: Camera,
  },
  {
    id: "coupons",
    label: "Discount Codes",
    href: "/admin/dashboard/coupons",
    blurb: "Run a promotion, and see what each code has done",
    icon: Ticket,
  },
  {
    id: "customers",
    label: "Customers",
    href: "/admin/dashboard/customers",
    blurb: "Who buys, how often, and who may be emailed",
    icon: Users,
  },
  {
    id: "marketing",
    label: "Marketing",
    href: "/admin/dashboard/marketing",
    blurb: "Send wishlist, low-stock and basket emails",
    icon: Mail,
  },
  {
    id: "manual-order",
    label: "Record a sale",
    href: "/admin/dashboard/manual-order",
    blurb: "An order taken in person, with a real invoice",
    icon: Store,
  },
  {
    id: "invoices",
    label: "Invoices",
    href: "/admin/dashboard/invoices",
    blurb: "Every invoice issued, with downloads and resends",
    icon: Scroll,
  },
  {
    id: "export",
    label: "Export",
    href: "/admin/dashboard/export",
    blurb: "Excel files for accounting, analysis and records",
    icon: Sheet,
  },
  {
    id: "import",
    label: "Import",
    href: "/admin/dashboard/import",
    blurb: "Bulk product, courier cost and expense uploads",
    icon: Upload,
  },
  {
    id: "profit-loss",
    label: "Profit & Loss",
    href: "/admin/dashboard/profit-loss",
    blurb: "Revenue, costs and what is actually left",
    icon: TrendingUp,
  },
  {
    id: "expenses",
    label: "Expenses",
    href: "/admin/dashboard/expenses",
    blurb: "What the business spends, so profit means something",
    icon: Receipt,
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/admin/dashboard/analytics",
    blurb: "Revenue, best sellers and stock to watch",
    icon: BarChart3,
  },
  {
    id: "insights",
    label: "Ask the data",
    href: "/admin/dashboard/ask-the-data",
    blurb: "Ask questions about the shop in plain English",
    icon: MessageSquareText,
  },
  {
    id: "settings",
    label: "Settings",
    href: "/admin/dashboard/settings",
    blurb: "Ask Wovenne, VIP thresholds and loyalty rates",
    icon: Settings,
  },
];

/** Route for a section id — used by the publish queue's Edit links. */
export function sectionHref(id: string): string {
  return ADMIN_SECTIONS.find((s) => s.id === id)?.href ?? "/admin/dashboard";
}

export function sectionById(id: string): AdminSection | undefined {
  return ADMIN_SECTIONS.find((s) => s.id === id);
}
