<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

$user   = require_user();
$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'update_profile':
        update_profile($user, $data);
        break;

    case 'update_picture':
        update_picture($user, $data);
        break;

    case 'change_password':
        change_password($user, $data);
        break;

    case 'request_change_code':
        ok(['change' => change_request_code(mfa_actor_user($user), field($data, 'purpose'))]);
        break;

    case 'add_address':
        save_address($user, null, $data);
        break;

    case 'edit_address':
        save_address($user, (int) ($data['id'] ?? 0), $data);
        break;

    case 'delete_address':
        delete_address($user, (int) ($data['id'] ?? 0));
        break;

    case 'default_address':
        set_default_address($user, (int) ($data['id'] ?? 0));
        break;

    case 'toggle_favorite':
        toggle_favorite($user, (int) ($data['product_id'] ?? 0));
        break;

    case 'mfa_status':
        ok(['mfa' => mfa_status_payload(mfa_actor_user($user))]);
        break;

    case 'mfa_start':
        $actor = mfa_actor_user($user);
        ok(['mfa' => array_merge(mfa_status_payload($actor), mfa_start_enrollment($actor))]);
        break;

    case 'mfa_confirm':
        $actor = mfa_actor_user($user);
        $result = mfa_confirm_enrollment($actor, field($data, 'code'));
        ok(['mfa' => array_merge($result, mfa_status_payload($actor))]);
        break;

    case 'mfa_disable':
        $actor = mfa_actor_user($user);
        mfa_disable($actor, (string) ($data['password'] ?? ''), field($data, 'code'));
        ok(['mfa' => mfa_status_payload($actor)]);
        break;

    default:
        throw new ApiError('Unknown account action.', 400);
}

/** Customer-scoped actor, so the customer cannot ask about someone else's MFA. */
function mfa_actor_user(array $user): array
{
    return [
        'type'  => 'user',
        'id'    => (int) $user['id'],
        'email' => (string) $user['email'],
        'name'  => (string) $user['name'],
    ];
}

function update_profile(array $user, array $data): void
{
    $name  = capitalize(field($data, 'name'));
    $email = strtolower(field($data, 'email'));
    $phone = field($data, 'phone');

    if (!valid_name($name)) {
        throw new ApiError('Please enter a valid full name.');
    }
    if (!valid_email($email)) {
        throw new ApiError('Please enter a valid email address.');
    }
    if (!valid_phone($phone)) {
        throw new ApiError('Please enter a valid 11-digit Philippine mobile number.');
    }

    $pdo = db();
    $dup = $pdo->prepare('SELECT id FROM users WHERE email = ? AND id <> ?');
    $dup->execute([$email, $user['id']]);
    if ($dup->fetch()) {
        throw new ApiError('That email is already used by another account.');
    }

    // Moving the account to a new sign-in address needs a code sent to the
    // address already on file. A name or phone edit alone does not.
    if (strcasecmp($email, (string) $user['email']) !== 0) {
        change_verify_code(mfa_actor_user($user), 'email', (string) ($data['code'] ?? ''));
    }

    $pdo->prepare('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?')
        ->execute([$name, $email, $phone, $user['id']]);
    ok();
}

function update_picture(array $user, array $data): void
{
    $image = (string) ($data['image'] ?? '');
    if ($image === '' || !str_starts_with($image, 'data:image/')) {
        throw new ApiError('Please choose a valid image.');
    }
    if (strlen($image) > 2_000_000) {
        throw new ApiError('That image is too large. Please pick a smaller photo.');
    }
    $stmt = db()->prepare('UPDATE users SET profile_image = ? WHERE id = ?');
    $stmt->execute([$image, $user['id']]);
    ok();
}

/** Signed-in customers change their own password from Profile > Security. */
function change_password(array $user, array $data): void
{
    $current = (string) ($data['current_password'] ?? '');
    $new     = (string) ($data['new_password'] ?? '');
    $confirm = (string) ($data['confirm_password'] ?? '');

    if ($new !== $confirm) {
        throw new ApiError('The new passwords do not match.');
    }
    if ($problem = password_problem($new)) {
        throw new ApiError($problem);
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT password FROM users WHERE id = ?');
    $stmt->execute([$user['id']]);
    $stored = (string) $stmt->fetchColumn();

    if (!password_verify($current, $stored)) {
        login_record($user['email'], false);
        throw new ApiError('Your current password is incorrect.');
    }
    if ($new === $current) {
        throw new ApiError('Your new password must be different from the current one.');
    }

    // A new password always needs a code emailed to the address on file, so a
    // stolen session cannot lock the owner out of their own account.
    change_verify_code(mfa_actor_user($user), 'password', (string) ($data['code'] ?? ''));

    $pdo->prepare('UPDATE users SET password = ?, auth_version = auth_version + 1 WHERE id = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $user['id']]);

    // Keeps this device signed in and drops every other one.
    sign_in_user($pdo, (int) $user['id']);
    login_record($user['email'], true);

    ok(['message' => 'Password updated. Other devices have been signed out.']);
}

function save_address(array $user, ?int $id, array $data): void
{
    // Typed or pinned, the address is cleaned up and checked in one place.
    $a   = address_input($data);
    $pdo = db();

    if ($id !== null && $id > 0) {
        $own = $pdo->prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?');
        $own->execute([$id, $user['id']]);
        if (!$own->fetch()) {
            throw new ApiError('Address not found.', 404);
        }
        $pdo->prepare('UPDATE addresses SET label = ?, address = ?, landmark = ?, lat = ?, lng = ? WHERE id = ?')
            ->execute([$a['label'], $a['address'], $a['landmark'], $a['lat'], $a['lng'], $id]);
        ok();
        return;
    }

    $count = address_count((int) $user['id']);
    if (address_limit_reached($count)) {
        throw address_limit_error();
    }

    // The first address a customer saves is the one checkout starts from.
    address_insert($pdo, (int) $user['id'], $a, $count === 0);
    ok();
}

function delete_address(array $user, int $id): void
{
    if ($id <= 0) {
        throw new ApiError('Address not found.', 404);
    }
    $pdo = db();
    $own = $pdo->prepare('SELECT is_default FROM addresses WHERE id = ? AND user_id = ?');
    $own->execute([$id, $user['id']]);
    $row = $own->fetch();
    if (!$row) {
        throw new ApiError('Address not found.', 404);
    }

    $pdo->prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?')->execute([$id, $user['id']]);

    // Promote another saved address so the customer always has a default.
    if ((int) $row['is_default'] === 1) {
        $next = $pdo->prepare('SELECT id FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1');
        $next->execute([$user['id']]);
        if ($nid = $next->fetchColumn()) {
            $pdo->prepare('UPDATE addresses SET is_default = 1 WHERE id = ?')->execute([(int) $nid]);
        }
    }
    ok();
}

function set_default_address(array $user, int $id): void
{
    if ($id <= 0) {
        throw new ApiError('Address not found.', 404);
    }
    $pdo = db();
    $own = $pdo->prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?');
    $own->execute([$id, $user['id']]);
    if (!$own->fetch()) {
        throw new ApiError('Address not found.', 404);
    }
    $pdo->prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?')->execute([$user['id']]);
    $pdo->prepare('UPDATE addresses SET is_default = 1 WHERE id = ?')->execute([$id]);
    ok();
}

function toggle_favorite(array $user, int $productId): void
{
    if ($productId <= 0) {
        throw new ApiError('Invalid product.');
    }

    $pdo = db();

    // Check the product really exists, so a stale id gets a readable 404
    // instead of a foreign key error leaking out as a 500.
    $exists = $pdo->prepare('SELECT 1 FROM products WHERE id = ?');
    $exists->execute([$productId]);
    if (!$exists->fetchColumn()) {
        throw new ApiError('That food is no longer on the menu.', 404);
    }

    // Read and write inside one transaction, with the row locked. Two quick
    // taps used to race past the SELECT and leave the loser with a duplicate
    // key 500, which the customer saw as "saving favorite failed".
    $pdo->beginTransaction();
    try {
        $check = $pdo->prepare('SELECT 1 FROM favorites WHERE user_id = ? AND product_id = ? FOR UPDATE');
        $check->execute([$user['id'], $productId]);
        $wasFavorited = (bool) $check->fetchColumn();

        if ($wasFavorited) {
            $pdo->prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?')
                ->execute([$user['id'], $productId]);
        } else {
            $pdo->prepare('INSERT INTO favorites (user_id, product_id) VALUES (?, ?)')
                ->execute([$user['id'], $productId]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    ok(['favorited' => !$wasFavorited]);
}
