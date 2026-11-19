export const getItemAsync = async (k: string) => localStorage.getItem(k);
export const setItemAsync = async (k: string, v: string) => localStorage.setItem(k, v);
export const deleteItemAsync = async (k: string) => localStorage.removeItem(k);
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 2;
export const AFTER_FIRST_UNLOCK = 3;
