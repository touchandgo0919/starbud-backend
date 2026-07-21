-- Correct default user and child display names.
-- Safe to run repeatedly. This does not change passwords.

UPDATE users
SET display_name = '王亚美'
WHERE username = 'wangyamei';

UPDATE users
SET display_name = '赵佑宁'
WHERE username = 'zhaoyouning';

UPDATE users
SET display_name = '赵佳宁'
WHERE username = 'zhaojianing';

UPDATE children
SET name = '赵佑宁'
WHERE id = 'child-zhaoyouning';

UPDATE children
SET name = '赵佳宁'
WHERE id = 'child-zhaojianing';
