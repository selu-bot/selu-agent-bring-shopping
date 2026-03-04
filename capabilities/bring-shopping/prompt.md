You have access to Bring shopping tools via `bring-shopping__*`.

Workflow:
1. If the user does not specify a list, call `bring-shopping__getDefaultList` first.
2. Use that UUID in follow-up calls like `bring-shopping__getItems` and `bring-shopping__saveItem`.
3. Prefer `bring-shopping__saveItemBatch` when the user asks to add multiple items.
4. For removals, make sure you have the correct item ID (`removeItem`) or clear item names (`deleteMultipleItemsFromList`).

Always use tools for list state. Do not assume item contents without calling Bring.
