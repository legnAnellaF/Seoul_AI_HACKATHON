import { readLocal, saveLocal } from './db.js';

const CART_KEY = 'seoul-demo-cart';
export const readCart = () => readLocal(CART_KEY, []);
export const writeCart = rows => saveLocal(CART_KEY, rows);

export function addCartMenu(item, store, quantity = 1) {
  if (!item?.available || !store || item.store_id !== store.id) {
    throw new Error('현재 담을 수 없는 메뉴예요. 가게 메뉴를 확인해 주세요.');
  }
  const rows = readCart();
  const index = rows.findIndex(row => row.id === item.id);
  const total = (rows[index]?.quantity || 0) + quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || total > 20) {
    throw new Error('메뉴당 최대 20개까지 담을 수 있습니다.');
  }
  const row = { ...item, store_name: store.name, quantity: total, selected: true };
  if (index === -1) rows.push(row);
  else rows[index] = row;
  writeCart(rows);
  return total;
}
