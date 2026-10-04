<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

require_admin();

$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'add':
        $name = mb_substr(field($data, 'name'), 0, 120);
        $fee  = field($data, 'fee');

        if ($name === '' || $fee === '') {
            throw new ApiError('Please enter the area and delivery fee.');
        }
        // A delivery fee is an amount, so it takes numbers and nothing else.
        if (!is_numeric($fee) || (float) $fee < 0) {
            throw new ApiError('Please enter a valid delivery fee — numbers only.');
        }

        // The fee is bound again for the UPDATE rather than using VALUES(fee),
        // which MySQL 8 deprecated and not every MySQL-compatible server
        // (TiDB) supports in that form.
        $amount = number_format((float) $fee, 2, '.', '');
        $stmt = db()->prepare(
            'INSERT INTO delivery_areas (name, fee) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE fee = ?'
        );
        $stmt->execute([$name, $amount, $amount]);
        ok();
        break;

    default:
        throw new ApiError('Unknown area action.', 400);
}
