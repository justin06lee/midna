const Storage = {
  getItemSync: (k: string) => localStorage.getItem(k),
  setItemSync: (k: string, v: string) => localStorage.setItem(k, v),
  removeItemSync: (k: string) => localStorage.removeItem(k),
  getItem: async (k: string) => localStorage.getItem(k),
  setItem: async (k: string, v: string) => localStorage.setItem(k, v),
  removeItem: async (k: string) => localStorage.removeItem(k),
};
export default Storage;
