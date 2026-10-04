<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

require_admin();

$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'add':
        $name     = mb_substr(field($data, 'name'), 0, 150);
        $price    = (float) ($data['price'] ?? 0);
        $category = field($data, 'category');
        $desc     = mb_substr(field($data, 'desc'), 0, 2000);
        $img      = (string) ($data['img'] ?? '');

        if ($name === '' || $price <= 0 || $price > 9_999_999.99) {
            throw new ApiError('Please enter a food name and a valid price.');
        }
        if (strlen($img) > 4_000_000) {
            throw new ApiError('That image is too large. Please pick a smaller photo.');
        }
        if ($img === '') {
            throw new ApiError('Please choose a product image from your storage or album.');
        }

        $stmt = db()->prepare(
            'INSERT INTO products (name, price, category_id, rating, reviews, description, image)
             VALUES (?, ?, ?, 4.7, 0, ?, ?)'
        );
        $stmt->execute([
            $name,
            $price,
            category_id($category),
            $desc !== '' ? $desc : 'Freshly prepared and served with care.',
            $img,
        ]);
        ok();
        break;

    case 'update':
        $id       = (int) ($data['id'] ?? 0);
        $name     = mb_substr(field($data, 'name'), 0, 150);
        $price    = (float) ($data['price'] ?? 0);
        $category = field($data, 'category');
        $desc     = mb_substr(field($data, 'desc'), 0, 2000);
        $img      = (string) ($data['img'] ?? '');

        if ($id <= 0) {
            throw new ApiError('Invalid product.');
        }
        if ($name === '' || $price <= 0 || $price > 9_999_999.99) {
            throw new ApiError('Please enter a food name and a valid price.');
        }
        if (strlen($img) > 4_000_000) {
            throw new ApiError('That image is too large. Please pick a smaller photo.');
        }

        $pdo = db();
        $exists = $pdo->prepare('SELECT image FROM products WHERE id = ?');
        $exists->execute([$id]);
        $current = $exists->fetch();
        if (!$current) {
            throw new ApiError('Product not found.', 404);
        }

        // No new photo means keep the existing one.
        $pdo->prepare(
            'UPDATE products SET name = ?, price = ?, category_id = ?, description = ?, image = ? WHERE id = ?'
        )->execute([
            $name,
            $price,
            category_id($category),
            $desc !== '' ? $desc : 'Freshly prepared and served with care.',
            $img !== '' ? $img : $current['image'],
            $id,
        ]);
        ok();
        break;

    case 'availability':
        $id        = (int) ($data['id'] ?? 0);
        $available = !empty($data['available']) ? 1 : 0;
        if ($id <= 0) {
            throw new ApiError('Invalid product.');
        }
        $stmt = db()->prepare('UPDATE products SET is_available = ? WHERE id = ?');
        $stmt->execute([$available, $id]);
        ok(['available' => (bool) $available]);
        break;

    case 'delete':
        $id = (int) ($data['id'] ?? 0);
        if ($id <= 0) {
            throw new ApiError('Invalid product.');
        }
        $stmt = db()->prepare('DELETE FROM products WHERE id = ?');
        $stmt->execute([$id]);
        ok();
        break;

    default:
        throw new ApiError('Unknown product action.', 400);
}

function category_id(string $name): int
{
    $cat = db()->prepare('SELECT id FROM categories WHERE name = ?');
    $cat->execute([$name]);
    $id = $cat->fetchColumn();
    if ($id === false) {
        throw new ApiError('Please choose a valid category.');
    }
    return (int) $id;
}
