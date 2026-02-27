-- Update all existing 'pro' plans to 'casual' plan
UPDATE profiles 
SET plan = 'casual' 
WHERE plan = 'pro';
