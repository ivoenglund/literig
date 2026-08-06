-- Nutrition calculations use foods/nutrients/food_nutrients exclusively.
-- Remove the obsolete wide catalog so it cannot become a parallel source.
DROP TABLE IF EXISTS food_catalog;