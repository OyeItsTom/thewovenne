export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_gbp: number;
  category: string | null;
  fabric: string | null;
  colour: string | null;
  stock_quantity: number;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
}

export interface OrderItem {
  id: string;
  name: string;
  price_gbp: number;
  quantity: number;
  size: string;
}

export interface Order {
  id: string;
  customer_email: string | null;
  total_gbp: number;
  payment_provider: "stripe" | "razorpay" | null;
  payment_status: string;
  items: OrderItem[];
  created_at: string;
}
