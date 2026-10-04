<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

require_admin();

$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'add':
        $name = mb_substr(capitalize(field($data, 'name')), 0, 80);
        $icon = mb_substr(field($data, 'icon', '🍴'), 0, 16) ?: '🍴';

        if ($name === '') {
            throw new ApiError('Please enter a category name.');
        }

        $exists = db()->prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)');
        $exists->execute([$name]);
        if ($exists->fetch()) {
            throw new ApiError('That category already exists.');
        }

        $stmt = db()->prepare('INSERT INTO categories (name, icon) VALUES (?, ?)');
        $stmt->execute([$name, $icon]);
        ok();
        break;

    case 'delete':
        $name = field($data, 'name');

        $stmt = db()->prepare('SELECT id, is_locked FROM categories WHERE name = ?');
        $stmt->execute([$name]);
        $cat = $stmt->fetch();
        if (!$cat) {
            throw new ApiError('Category not found.');
        }
        if ((int) $cat['is_locked'] === 1) {
            throw new ApiError('This category cannot be removed.');
        }

        $used = db()->prepare('SELECT COUNT(*) FROM products WHERE category_id = ?');
        $used->execute([(int) $cat['id']]);
        if ((int) $used->fetchColumn() > 0) {
            throw new ApiError('This category has foods assigned to it. Move or remove those foods first.');
        }

        $del = db()->prepare('DELETE FROM categories WHERE id = ?');
        $del->execute([(int) $cat['id']]);
        ok();
        break;

    default:
        throw new ApiError('Unknown category action.', 400);
}
