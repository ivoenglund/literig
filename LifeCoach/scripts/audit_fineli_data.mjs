import { getFineliCatalog } from '../import-fineli-full.js';

const catalog = await getFineliCatalog();
const foodsWithoutValues = catalog.foods
  .filter((food) => !(catalog.valuesByFoodId.get(food.FOODID) || []).length)
  .map((food) => ({ id: Number(food.FOODID), name: catalog.names.get(food.FOODID).en }));

console.log(JSON.stringify({
  expected: catalog.expected,
  foodsWithoutNutrientValues: foodsWithoutValues
}, null, 2));
